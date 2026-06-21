import { type Media } from "@dopamine/contracts";
import { Injectable } from "@nestjs/common";

import { CatalogService } from "../catalog/catalog.service";
import { StructuredLogger } from "../common/logger";
import { EventBus } from "../events/event-bus.service";
import { PrismaService } from "../prisma/prisma.service";
import { type GenerationEnrichJob } from "../queue/queue.constants";
import { StorageService } from "../storage/storage.service";

import { FakeGenClient } from "./fake-gen.client";

/** Result of one enrich pass; `retry` tells the processor to throw for a retry. */
export interface EnrichResult {
  outcome: "ready" | "degraded" | "pending";
  flipped: number;
}

/**
 * Context the worker threads into each pass so the service can bound its polling
 * (M3). `attempt` is 1-based (the current BullMQ attempt); `maxAttempts` is the
 * queue's configured `attempts`. When the LAST attempt still sees
 * `generating_media` we DEGRADE instead of throwing forever — fake-gen may have
 * restarted and lost the batch, so polling can never resolve.
 */
export interface EnrichContext {
  attempt: number;
  maxAttempts: number;
}

/**
 * EnrichService (charter §5.5.2, doc 01 §11) — the worker-driven async media swap.
 *
 * For a `generation.enrich` job it:
 *   1. polls fake-gen `GET /media/:batchId` (NOT a webhook — the worker drives it).
 *   2. if still `generating_media` → throws so BullMQ retries with backoff.
 *   3. on `ready`/`degraded`: for each listing, GETs the final `/img/fin/*` bytes,
 *      INGESTS them to MinIO (content-addressed → idempotent), updates
 *      `listing.media` (status ready/degraded, MinIO hero url), and writes an
 *      `images.ready`/`images.degraded` outbox event in the SAME transaction.
 *   4. the OutboxRelay fans those events out over Redis pub/sub on the
 *      `order/generation` channel the 3b SSE gateway consumes.
 *
 * Idempotent: re-running (DLQ redelivery) re-ingests the same content-addressed
 * blob (no dup) and re-writes the same media (no-op). The inbox table guards
 * duplicate event emission per consumer.
 */
@Injectable()
export class EnrichService {
  private readonly logger = new StructuredLogger("enrich");

  constructor(
    private readonly prisma: PrismaService,
    private readonly fakeGen: FakeGenClient,
    private readonly storage: StorageService,
    private readonly catalog: CatalogService,
    private readonly eventBus: EventBus,
  ) {}

  async enrich(job: GenerationEnrichJob, ctx?: EnrichContext): Promise<EnrichResult> {
    const poll = await this.fakeGen.pollMedia(job.generationId);

    if (poll.outcome === "generating_media") {
      // If we've exhausted the polling budget (fake-gen likely restarted and lost
      // the batch), DEGRADE rather than retry forever (M3): keep the placeholder,
      // flip media.status → degraded, emit images.degraded. The listing stays a
      // usable card; it just never gets its final hero.
      if (ctx && ctx.attempt >= ctx.maxAttempts) {
        return this.degradeStalled(job);
      }
      // Not ready yet — throw so BullMQ retries with exponential backoff.
      throw new MediaNotReadyError(job.generationId);
    }

    // Map fake-gen poll items (in batch order, g0..gN) onto our minted listing ids.
    let flipped = 0;
    for (let i = 0; i < poll.items.length; i++) {
      const item = poll.items[i];
      const listingId = job.listingIds[i];
      if (!item || !listingId) continue;

      const media = await this.ingestFinal(item.media);
      const imageUrls = media.hero ? [media.hero.url] : [];

      await this.prisma.$transaction(async (tx) => {
        // Idempotent inbox guard: per-(event, consumer) so a redelivery won't
        // double-emit the swap event.
        const inboxId = `${job.generationId}:${listingId}`;
        const already = await tx.inboxEvent.findUnique({
          where: { inbox_pk: { id: inboxId, consumer: "generation.enrich" } },
        });

        await tx.listing.update({
          where: { id: listingId },
          data: {
            media: media,
            imageUrls,
            status: media.status === "ready" ? "ready" : "degraded",
          },
        });

        if (!already) {
          await tx.inboxEvent.create({ data: { id: inboxId, consumer: "generation.enrich" } });
          await this.eventBus.publishTx(tx, {
            type: media.status === "ready" ? "images.ready" : "images.degraded",
            generationId: job.generationId,
            listingId,
            media,
          });
        }
      });
      flipped++;
    }

    this.logger.log(
      `enrich ${job.generationId}: outcome=${poll.outcome} flipped=${String(flipped)} listings`,
    );
    return { outcome: poll.outcome, flipped };
  }

  /**
   * Degrade-after-timeout path (M3). The batch never resolved (fake-gen restarted
   * / lost it), so we stop polling and mark each listing `degraded` while keeping
   * its existing placeholder media, then emit `images.degraded`. Idempotent via
   * the same per-(generation, listing) inbox guard the ready path uses.
   */
  private async degradeStalled(job: GenerationEnrichJob): Promise<EnrichResult> {
    let flipped = 0;
    for (const listingId of job.listingIds) {
      await this.prisma.$transaction(async (tx) => {
        const listing = await tx.listing.findUnique({ where: { id: listingId } });
        if (!listing) return;

        // Keep the placeholder hero; only flip the status to the usable `degraded`.
        const current = listing.media as unknown as Media;
        const media: Media = { ...current, status: "degraded" };

        const inboxId = `${job.generationId}:${listingId}`;
        const already = await tx.inboxEvent.findUnique({
          where: { inbox_pk: { id: inboxId, consumer: "generation.enrich" } },
        });

        await tx.listing.update({
          where: { id: listingId },
          data: { media, status: "degraded" },
        });

        if (!already) {
          await tx.inboxEvent.create({ data: { id: inboxId, consumer: "generation.enrich" } });
          await this.eventBus.publishTx(tx, {
            type: "images.degraded",
            generationId: job.generationId,
            listingId,
            media,
          });
        }
      });
      flipped++;
    }

    this.logger.warn(
      `enrich ${job.generationId}: media never ready after the poll budget — degraded ${String(flipped)} listings`,
    );
    return { outcome: "degraded", flipped };
  }

  /** Fetch + ingest the final hero (and alternates) to MinIO, rewriting urls. */
  private async ingestFinal(media: Media): Promise<Media> {
    const hero = media.hero ? await this.ingestAsset(media.hero) : null;
    const alternates = await Promise.all(media.alternates.map((a) => this.ingestAsset(a)));
    return { ...media, hero, alternates };
  }

  private async ingestAsset(asset: Media["alternates"][number]): Promise<Media["alternates"][number]> {
    try {
      const ingested = await this.storage.ingestFromUrl(asset.url);
      return { ...asset, url: ingested.url };
    } catch (err) {
      this.logger.warn(`final ingest failed (${(err as Error).message}); keeping provider url`);
      return asset;
    }
  }
}

/** Thrown when fake-gen reports media is still rendering → triggers a BullMQ retry. */
export class MediaNotReadyError extends Error {
  constructor(generationId: string) {
    super(`media not ready for generation ${generationId}`);
    this.name = "MediaNotReadyError";
  }
}
