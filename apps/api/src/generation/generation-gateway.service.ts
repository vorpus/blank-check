import {
  type GenerationResult,
  type Listing,
  type Media,
  type SearchGeneration,
} from "@dopamine/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { type Queue } from "bullmq";

import { CatalogService, type GeneratedListingInput } from "../catalog/catalog.service";
import { mintId } from "../common/ids";
import { StructuredLogger } from "../common/logger";
import { requestContext } from "../common/request-context";
import { ENV } from "../config/config.module";
import { type Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { GENERATION_ENRICH_QUEUE, QUEUE_NAMES, type GenerationEnrichJob } from "../queue/queue.constants";
import { RedisLockService } from "../redis/redis-lock.service";
import { RedisService } from "../redis/redis.service";
import { CanonicalizerService } from "../search/canonicalizer.service";
import { StorageService } from "../storage/storage.service";

import { FakeGenClient } from "./fake-gen.client";
import { type GenerationOutcome, type GenerationRequestInput } from "./generation.types";

/**
 * GenerationGateway (doc 01 §2, §4.3, §4.4) — owns `generation_jobs`. The miss
 * orchestrator:
 *   1. SETNX generation lock on the canon key → collapses concurrent identical
 *      misses (losers attach to the in-flight job, return skeleton).
 *   2. upsert generation_jobs (unique storefront+canon) → the dedup record.
 *   3. call fake-gen `/generate-grid` (the GenerationProvider fast path).
 *   4. ingest each placeholder hero to MinIO (backend owns ingestion, charter
 *      §5.5.2) → rewrite media.hero.url to the MinIO url.
 *   5. transactional, idempotent catalog write-back (one anchor + N fillers).
 *   6. set the exact-cache `canon → anchor listing_id` so the NEXT identical
 *      search is an instant L1 hit (the demo's "re-search → cache hit").
 *   7. enqueue the `generation.enrich` BullMQ job (worker polls fake-gen for
 *      final media, ingests, flips media=ready, publishes images.ready).
 */
@Injectable()
export class GenerationGateway {
  private readonly logger = new StructuredLogger("generation-gateway");

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly fakeGen: FakeGenClient,
    private readonly storage: StorageService,
    private readonly redis: RedisService,
    private readonly lock: RedisLockService,
    private readonly canon: CanonicalizerService,
    @Inject(ENV) private readonly env: Env,
    @Inject(GENERATION_ENRICH_QUEUE) private readonly enrichQueue: Queue<GenerationEnrichJob>,
  ) {}

  /**
   * Run a generation for a search miss. Lock-guarded so only the first concurrent
   * caller generates; losers return a `pending` hint with no listings (they'll
   * pick up the persisted cards on the next search / via the exact-cache).
   */
  async requestGeneration(input: GenerationRequestInput): Promise<GenerationOutcome | null> {
    const lockKey = this.canon.lockKey(input.storefrontId, input.canonicalQuery);
    const handle = await this.lock.acquire(lockKey, this.env.GEN_LOCK_TTL_MS);

    if (!handle) {
      // Lost the race — a generation is already in flight for this canon. Attach
      // to it: return a pending hint keyed on the in-flight job's generation id.
      const existing = await this.prisma.generationJob.findUnique({
        where: {
          storefrontId_canonicalQuery: {
            storefrontId: input.storefrontId,
            canonicalQuery: input.canonicalQuery,
          },
        },
      });
      return {
        listings: [],
        generation: this.hint(input.canonicalQuery, existing?.generationId ?? "pending", "pending"),
      };
    }

    try {
      return await this.generateLocked(input);
    } finally {
      await this.lock.release(handle);
    }
  }

  private async generateLocked(input: GenerationRequestInput): Promise<GenerationOutcome> {
    const requestId = mintId("generation");

    // The generation_jobs upsert is the dedup point (unique storefront+canon).
    await this.prisma.generationJob.upsert({
      where: {
        storefrontId_canonicalQuery: {
          storefrontId: input.storefrontId,
          canonicalQuery: input.canonicalQuery,
        },
      },
      create: {
        id: mintId("generationJob"),
        storefrontId: input.storefrontId,
        verticalId: input.verticalId,
        canonicalQuery: input.canonicalQuery,
        requestId,
        status: "running",
        regime: input.regime,
        batchSize: input.count,
      },
      update: { status: "running", regime: input.regime, batchSize: input.count },
    });

    // Call the GenerationProvider fast path (fake-gen) for the whole batch.
    const envelope = await this.fakeGen.generateGrid({
      query: input.rawQuery,
      vertical: input.verticalId,
      deviceId: input.deviceId,
      requestId,
      count: input.count,
    });

    const batchGenerationId = envelope.generation_id;
    const persisted: Listing[] = [];
    const listingIds: string[] = [];

    for (let i = 0; i < envelope.results.length; i++) {
      const result = envelope.results[i];
      if (!result) continue;
      const media = await this.ingestPlaceholder(result.listing.media);
      const writeInput: GeneratedListingInput = {
        storefrontId: input.storefrontId,
        verticalId: input.verticalId,
        canonicalQuery: input.canonicalQuery,
        generationId: batchGenerationId,
        fields: {
          title: result.listing.title,
          description: result.listing.description,
          priceCents: result.listing.price.amount_cents,
          currency: result.listing.price.currency,
          attributes: result.listing.attributes,
        },
        media,
        imageUrls: media.hero ? [media.hero.url] : [],
        isAnchor: i === 0, // the first variant is the dedup anchor (exact-cache target)
      };
      const listing = await this.catalog.writeBackGenerated(writeInput);
      persisted.push(listing);
      listingIds.push(listing.id);
    }

    // Set the exact-cache so the NEXT identical search is an instant L1 hit.
    // TTL-bounded (EXACT_CACHE_TTL_SEC) so a stale anchor can't live forever.
    if (listingIds.length > 0) {
      await this.redis.client.set(
        this.canon.cacheKey(input.storefrontId, input.canonicalQuery),
        listingIds[0] ?? "",
        "EX",
        this.env.EXACT_CACHE_TTL_SEC,
      );
    }

    // Persist the batch generation id on the job + enqueue the worker enrichment.
    await this.prisma.generationJob.update({
      where: {
        storefrontId_canonicalQuery: {
          storefrontId: input.storefrontId,
          canonicalQuery: input.canonicalQuery,
        },
      },
      data: { status: "succeeded", generationId: batchGenerationId },
    });

    await this.enrichQueue.add(QUEUE_NAMES.generationEnrich, {
      jobId: requestId,
      // Propagate the originating HTTP request id (falls back to the generation id)
      // so the worker's logs/events correlate back to the search that enqueued it.
      requestId: requestContext.requestId(),
      generationId: batchGenerationId,
      storefrontId: input.storefrontId,
      verticalId: input.verticalId,
      canonicalQuery: input.canonicalQuery,
      listingIds,
    });

    this.logger.log(
      `generated ${String(persisted.length)} listings for "${input.canonicalQuery}" (batch ${batchGenerationId})`,
    );

    return {
      listings: persisted,
      generation: this.hint(
        input.canonicalQuery,
        batchGenerationId,
        "pending",
        media0ExpectedMs(persisted),
      ),
    };
  }

  /**
   * Ingest a placeholder hero (fetchable fake-gen URL) into MinIO and rewrite the
   * media block's hero url to the MinIO url. Backend owns ingestion (charter
   * §5.5.2); the content-addressed key makes it idempotent.
   */
  private async ingestPlaceholder(media: Media): Promise<Media> {
    if (!media.hero) return media;
    try {
      const ingested = await this.storage.ingestFromUrl(media.hero.url);
      return { ...media, hero: { ...media.hero, url: ingested.url } };
    } catch (err) {
      // Degraded path: keep the provider URL (still fetchable) rather than fail
      // the whole search. The enrich pass retries ingestion.
      this.logger.warn(`placeholder ingest failed (${(err as Error).message}); keeping provider url`);
      return media;
    }
  }

  private hint(
    canonicalQuery: string,
    generationId: string,
    status: SearchGeneration["status"],
    pollAfterMs = 1500,
  ): SearchGeneration {
    return { status, canonicalQuery, generationId, pollAfterMs };
  }
}

/** Pull the expected-ready hint off the first generated card, if any. */
function media0ExpectedMs(listings: Listing[]): number {
  const first = listings[0];
  return first?.media.expected_ready_ms ?? 1500;
}

/** Re-export the provider result type for the worker. */
export type { GenerationResult };
