import { Injectable } from "@nestjs/common";
import { type FastifyReply } from "fastify";

import { StructuredLogger } from "../common/logger";
import { GENERATION_CHANNEL, orderChannel } from "../events/pubsub.constants";
import { TrackingService } from "../orders/tracking.service";
import { RedisService } from "../redis/redis.service";

import { subscribeChannel } from "./pubsub-subscription";
import { SseResponder } from "./sse";

/**
 * RealtimeGateway (doc 01 §8, charter §4.3) — the SSE fan-out. ONE place wires the
 * SseResponder + the pub/sub subscription helper together; the three streams
 * (order tracking, generation swaps) differ only in their channel + an optional
 * replay/filter. No copy-pasted SSE plumbing.
 *
 * Order stream contract:
 *   1. (optional) replay from `tracking_events WHERE seq > Last-Event-ID` so a
 *      reconnecting client catches up gap-free before live events (no gaps, no
 *      duplicates — the client also drops `seq <= lastApplied`).
 *   2. subscribe to Redis `order:{id}`; frame each `tracking_event` (the
 *      OutboxRelay already mapped it onto the public wire shape with seq+ts).
 *   3. clean unsubscribe on disconnect (SseResponder.onClose → subscription.unsubscribe).
 */
@Injectable()
export class RealtimeGateway {
  private readonly logger = new StructuredLogger("realtime-gateway");

  constructor(
    private readonly redis: RedisService,
    private readonly tracking: TrackingService,
  ) {}

  /**
   * Stream an order's tracking events over SSE. `lastEventId` (the SSE
   * `Last-Event-ID` header) triggers a replay of only later events before the
   * live subscription starts.
   */
  async streamOrder(reply: FastifyReply, orderId: string, lastEventId: number | null): Promise<void> {
    const channel = orderChannel(orderId);

    // Subscribe FIRST so no live event published during the replay window is
    // lost; the client de-dupes by seq, so an overlap is harmless (gap-free > no-dup).
    const subscription = await subscribeChannel(this.redis, channel, (payload) => {
      const seq = typeof payload === "object" && payload && "seq" in payload
        ? (payload as { seq?: number }).seq
        : undefined;
      const type = typeof payload === "object" && payload && "type" in payload
        ? (payload as { type?: string }).type ?? "tracking_event"
        : "tracking_event";
      responder.send({ id: seq, type, data: payload });
    });

    const responder = new SseResponder(reply, () => subscription.unsubscribe());

    // Replay missed events (Last-Event-ID) directly from the persisted log.
    if (lastEventId !== null) {
      const replay = await this.tracking.eventsSince(orderId, lastEventId);
      for (const evt of replay) responder.send({ id: evt.seq, type: evt.type, data: evt });
      this.logger.log(`order ${orderId}: replayed ${String(replay.length)} events after seq ${String(lastEventId)}`);
    }
  }

  /**
   * Stream generation media swaps (`images.ready` / `images.degraded`) for one
   * batch `generationId`. Rides the same fan-out channel as orders; we filter to
   * the requested generation so the web can swap placeholder→final after a
   * cold-miss search (doc 05 §4.3). Reuses the SAME SSE machinery as order streams.
   */
  async streamGeneration(reply: FastifyReply, generationId: string): Promise<void> {
    const subscription = await subscribeChannel(this.redis, GENERATION_CHANNEL, (payload) => {
      if (!isForGeneration(payload, generationId)) return;
      const evt = payload as { type?: string; seq?: number };
      responder.send({ id: evt.seq, type: evt.type ?? "images.ready", data: payload });
    });

    const responder = new SseResponder(reply, () => subscription.unsubscribe());
    this.logger.log(`generation stream open for ${generationId}`);
  }
}

/** True if a generation fan-out message targets the requested batch id. */
function isForGeneration(payload: unknown, generationId: string): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "generation_id" in payload &&
    (payload as { generation_id?: string }).generation_id === generationId
  );
}
