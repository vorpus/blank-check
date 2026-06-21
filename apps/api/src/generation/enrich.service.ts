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

  async enrich(job: GenerationEnrichJob): Promise<EnrichResult> {
    const poll = await this.fakeGen.pollMedia(job.generationId);

    if (poll.outcome === "generating_media") {
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
