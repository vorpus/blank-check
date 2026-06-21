import { type TrackingEvent, type TrackingSnapshot } from "@dopamine/contracts";
import { Injectable } from "@nestjs/common";

import { NotFoundError } from "../common/errors";
import { PrismaService } from "../prisma/prisma.service";
import { VerticalRegistry } from "../vertical-registry/vertical-registry.service";

/**
 * TrackingService (doc 01 §8, charter §4.3) — the snapshot + replay source. The
 * snapshot reads straight from `orders` + the `tracking_events` log (the DB is the
 * source of truth; transport is an accelerator — doc 05 §1.5). The SSE gateway
 * uses `eventsSince` for `Last-Event-ID` replay: only events with `seq > lastId`,
 * in order, so a reconnecting client catches up gap-free with no duplicates.
 */
@Injectable()
export class TrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: VerticalRegistry,
  ) {}

  /** Authoritative catch-up snapshot for GET /v1/orders/{id}/tracking. */
  async snapshot(userId: string, orderId: string): Promise<TrackingSnapshot> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.userId !== userId) throw new NotFoundError(`order not found: ${orderId}`);

    const vertical = this.registry.get(order.verticalId);
    const rows = await this.prisma.trackingEvent.findMany({
      where: { orderId },
      orderBy: { seq: "asc" },
    });
    const events: TrackingEvent[] = rows.map((r) => this.toWire(r));

    return {
      orderId,
      state: order.state,
      display: {
        stages: vertical.tracking.stagesFor(order.state),
        trackingMode: vertical.tracking.trackingMode,
      },
      events,
      latestSeq: order.seq,
    };
  }

  /**
   * Ordered tracking events with `seq > lastSeq` for SSE `Last-Event-ID` replay.
   * Reads the persisted log directly (no auth re-check — the gateway authorizes
   * the order before subscribing).
   */
  async eventsSince(orderId: string, lastSeq: number): Promise<TrackingEvent[]> {
    const rows = await this.prisma.trackingEvent.findMany({
      where: { orderId, seq: { gt: lastSeq } },
      orderBy: { seq: "asc" },
    });
    return rows.map((r) => this.toWire(r));
  }

  /** Map a persisted tracking_events row onto the public TrackingEvent wire shape. */
  private toWire(row: {
    orderId: string;
    seq: number;
    state: string;
    label: string;
    payload: unknown;
    occurredAt: Date;
  }): TrackingEvent {
    const display = extractDisplay(row.payload);
    return {
      type: "tracking_event",
      seq: row.seq,
      ts: row.occurredAt.toISOString(),
      orderId: row.orderId,
      state: row.state,
      label: row.label,
      ...(display ? { display } : {}),
    };
  }
}

/** Pull the optional `display` block stamped on the tracking_event payload. */
function extractDisplay(payload: unknown): TrackingEvent["display"] | undefined {
  if (payload && typeof payload === "object" && "display" in payload) {
    return (payload as { display: TrackingEvent["display"] }).display;
  }
  return undefined;
}
