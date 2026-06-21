import { ImagesDegradedSchema, ImagesReadySchema, TrackingEventSchema } from "@dopamine/contracts";
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
        // Internal signal only — there is no `order.placed` wire event. The first
        // visible client event is the initial state's tracking_event (or, for
        // Stage 1's `confirmed` initial state, the order detail the client already
        // has). Nothing to fan out.
        return;
      case "order.transition": {
        // M3 RESOLVED: map the internal order.transition onto the PUBLIC
        // TrackingEventSchema wire shape (mirroring images.ready/degraded above).
        // The `seq` + `label` + `display` come from the persisted tracking_events
        // row written atomically with the state change — so the wire event is a
        // faithful projection of the durable, gap-free per-order log (NOT a Redis
        // counter). The SSE gateway frames this with `id:`=seq directly.
        const row = await this.prisma.trackingEvent.findUnique({
          where: { orderId_seq: { orderId: event.orderId, seq: event.seq } },
        });
        if (!row) {
          this.logger.warn(`order.transition ${event.orderId}#${String(event.seq)} has no tracking_event row`);
          return;
        }
        const wire = TrackingEventSchema.parse({
          type: "tracking_event",
          seq: row.seq,
          ts: row.occurredAt.toISOString(),
          orderId: row.orderId,
          state: row.state,
          label: row.label,
          ...(extractDisplay(row.payload) ? { display: extractDisplay(row.payload) } : {}),
        });
        await this.redis.client.publish(orderChannel(event.orderId), JSON.stringify(wire));
        return;
      }
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  /**
   * Per-GENERATION monotonic seq for the images.ready/degraded swap events
   * (charter §4.3). Generation swaps have no persisted per-batch log, so a Redis
   * counter is the right cursor here. (M4 — order tracking seq — is now derived
   * from the durable `tracking_events` PK in the order.transition case above, NOT
   * from this counter.)
   */
  private async nextSeq(generationId: string): Promise<number> {
    return this.redis.client.incr(`seq:gen:${generationId}`);
  }
}

/** Pull the optional `display` block stamped on a tracking_event payload. */
function extractDisplay(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "display" in payload) {
    return (payload).display;
  }
  return undefined;
}
