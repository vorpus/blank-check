import { EventEmitter } from "node:events";

import { type TrackingEvent } from "@dopamine/contracts";
import { type FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { type TrackingService } from "../orders/tracking.service";
import { type RedisService } from "../redis/redis.service";

import { RealtimeGateway } from "./realtime.gateway";

/**
 * RealtimeGateway SSE Last-Event-ID replay (charter §4.3, doc 05 §5.1). Pins:
 * reconnecting with `Last-Event-ID: N` replays ONLY events with `seq > N` (from
 * the persisted log), in order, before live streaming — gap-free, no duplicates.
 */

function evt(seq: number): TrackingEvent {
  return {
    type: "tracking_event",
    seq,
    ts: "2026-06-21T00:00:00.000Z",
    orderId: "ord_1",
    state: seq === 5 ? "shipped" : "packed",
    label: "L",
  };
}

/** A FastifyReply double that captures the raw SSE frames written. */
function makeReply(): { reply: FastifyReply; frames: string[] } {
  const frames: string[] = [];
  const raw = Object.assign(new EventEmitter(), {
    writeHead: vi.fn().mockReturnThis(),
    write: vi.fn((chunk: string) => {
      frames.push(chunk);
      return true;
    }),
    end: vi.fn(),
    writableEnded: false,
  });
  return { reply: { raw } as unknown as FastifyReply, frames };
}

describe("RealtimeGateway — Last-Event-ID replay", () => {
  it("replays only events with seq > lastEventId, in order", async () => {
    // The persisted log has seq 0..5; the gateway should ask for seq > 3.
    const eventsSince = vi.fn((_orderId: string, lastSeq: number) =>
      Promise.resolve([evt(4), evt(5)].filter((e) => e.seq > lastSeq)),
    );
    const tracking = { eventsSince } as unknown as TrackingService;

    const subscriber = Object.assign(new EventEmitter(), {
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    });
    const redis = { createSubscriber: vi.fn(() => subscriber) } as unknown as RedisService;

    const gateway = new RealtimeGateway(redis, tracking);
    const { reply, frames } = makeReply();

    await gateway.streamOrder(reply, "ord_1", 3);

    // Asked the persisted log for events after seq 3 only.
    expect(eventsSince).toHaveBeenCalledWith("ord_1", 3);

    // The replayed frames carry exactly seq 4 then 5 (not 0..3), with id: lines.
    const dataFrames = frames.filter((f) => f.includes("event: tracking_event"));
    expect(dataFrames).toHaveLength(2);
    const joined = frames.join("");
    expect(joined).toContain("id: 4");
    expect(joined).toContain("id: 5");
    expect(joined).not.toContain("id: 3");
    // Ordering: id 4 appears before id 5.
    expect(joined.indexOf("id: 4")).toBeLessThan(joined.indexOf("id: 5"));
  });

  it("does not replay when there is no Last-Event-ID (fresh connect)", async () => {
    const eventsSince = vi.fn();
    const tracking = { eventsSince } as unknown as TrackingService;
    const subscriber = Object.assign(new EventEmitter(), {
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    });
    const redis = { createSubscriber: vi.fn(() => subscriber) } as unknown as RedisService;

    const gateway = new RealtimeGateway(redis, tracking);
    const { reply } = makeReply();

    await gateway.streamOrder(reply, "ord_1", null);
    expect(eventsSince).not.toHaveBeenCalled();
  });
});
