import { ImagesDegradedSchema, ImagesReadySchema } from "@dopamine/contracts";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";

import { StructuredLogger } from "../common/logger";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

import { type DomainEvent } from "./domain-events";
import { GENERATION_CHANNEL, orderChannel } from "./pubsub.constants";

const POLL_INTERVAL_MS = 250;
const BATCH = 50;

/**
 * OutboxRelay (doc 01 §2.2, §10) — drains the transactional outbox to Redis
 * pub/sub. Runs in BOTH api and worker (whichever wins a row first marks it
 * published; the SELECT … FOR UPDATE SKIP LOCKED claim keeps them from
 * double-publishing). Maps each internal DomainEvent onto its public
 * `@dopamine/contracts` wire shape, stamps `seq` + `ts`, and publishes onto the
 * generation/order fan-out channels the 3b SSE gateway consumes.
 *
 * `start()` begins the poll loop; `stop()` halts it (used by tests + shutdown).
 */
@Injectable()
export class OutboxRelay implements OnModuleDestroy {
  private readonly logger = new StructuredLogger("outbox-relay");
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.drainOnce();
    }, POLL_INTERVAL_MS);
    this.logger.log("outbox relay started");
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** One drain pass. Public so tests can pump it deterministically. */
  async drainOnce(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    try {
      // Claim pending rows atomically with SKIP LOCKED so api + worker relays
      // never publish the same event twice.
      const claimed = await this.prisma.$transaction(async (tx) => {
        // Column names are camelCase (Prisma maps tables to snake_case via @@map
        // but leaves field/column names as declared) → quote "createdAt".
        const rows = await tx.$queryRaw<{ id: string; type: string; payload: unknown }[]>`
          SELECT id, type, payload FROM outbox_events
          WHERE status = 'pending'
          ORDER BY "createdAt" ASC
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED`;
        if (rows.length === 0) return [];
        const ids = rows.map((r) => r.id);
        await tx.outboxEvent.updateMany({
          where: { id: { in: ids } },
          data: { status: "published", publishedAt: new Date() },
        });
        return rows;
      });

      for (const row of claimed) {
        await this.publish(row.payload as DomainEvent);
      }
      return claimed.length;
    } catch (err) {
      this.logger.error(`drain failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.draining = false;
    }
  }

  /** Map an internal event onto its public wire shape + channel, then publish. */
  private async publish(event: DomainEvent): Promise<void> {
    switch (event.type) {
      case "images.ready": {
        const seq = await this.nextSeq(event.generationId);
        const wire = ImagesReadySchema.parse({
          type: "images.ready",
          seq,
          ts: new Date().toISOString(),
          generation_id: event.generationId,
          media: event.media,
        });
        await this.redis.client.publish(GENERATION_CHANNEL, JSON.stringify(wire));
        return;
      }
      case "images.degraded": {
        const seq = await this.nextSeq(event.generationId);
        const wire = ImagesDegradedSchema.parse({
          type: "images.degraded",
          seq,
          ts: new Date().toISOString(),
          generation_id: event.generationId,
          media: event.media,
        });
        await this.redis.client.publish(GENERATION_CHANNEL, JSON.stringify(wire));
        return;
      }
      case "listing.generated":
        // In-process signal only (no client wire event). Useful for cache warm /
        // metrics; nothing to fan out to the browser.
        return;
      case "order.placed":
      case "order.transition": {
        // Seam for 3b: the tracking event projection lands with the orders module.
        // We still publish a thin notification so the 3b gateway has a channel.
        // TODO(3b): map the order event onto the public TrackingEventSchema wire
        // shape (like images.ready/degraded above) instead of publishing the raw
        // internal DomainEvent JSON.
        await this.redis.client.publish(orderChannel(event.orderId), JSON.stringify(event));
        return;
      }
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  /** Per-generation monotonic seq for the realtime event contract (charter §4.3). */
  private async nextSeq(generationId: string): Promise<number> {
    // TODO(3b): for ORDER tracking events, derive `seq` from the tracking_events
    // PK (a durable, gap-free per-order sequence) rather than this Redis counter,
    // which resets if Redis is flushed and isn't tied to the persisted projection.
    return this.redis.client.incr(`seq:gen:${generationId}`);
  }
}
