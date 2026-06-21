import { describe, it, expect } from "vitest";

import { RealtimeEventSchema, type RealtimeEvent } from "./realtime.js";

const base = { seq: 7, ts: "2026-06-21T12:00:01Z" };
const ULID = "01J9Z3K8Q0X4M7P2R5T6V8W9Y0";

const readyMedia = {
  status: "ready" as const,
  hero: { url: "http://minio.local/x.png", kind: "image" as const, blurhash: null, aspect_ratio: 1 },
  alternates: [],
  expected_ready_ms: null,
  generation_id: `gen_${ULID}`,
};

describe("RealtimeEventSchema discriminated union", () => {
  it("parses tracking_event", () => {
    const e: unknown = {
      ...base,
      type: "tracking_event",
      orderId: `ord_${ULID}`,
      state: "shipped",
      label: "Shipped",
    };
    const parsed = RealtimeEventSchema.parse(e);
    expect(parsed.type).toBe("tracking_event");
    if (parsed.type === "tracking_event") expect(parsed.state).toBe("shipped");
  });

  it("parses geo_position (reserved variant)", () => {
    const e: unknown = {
      ...base,
      type: "geo_position",
      position: { orderId: `ord_${ULID}`, lat: 1, lng: 2 },
    };
    const parsed = RealtimeEventSchema.parse(e);
    expect(parsed.type).toBe("geo_position");
    if (parsed.type === "geo_position") expect(parsed.position.heading).toBeNull();
  });

  it("parses images.ready", () => {
    const e: unknown = { ...base, type: "images.ready", generation_id: `gen_${ULID}`, media: readyMedia };
    expect(RealtimeEventSchema.parse(e).type).toBe("images.ready");
  });

  it("parses images.degraded", () => {
    const e: unknown = {
      ...base,
      type: "images.degraded",
      generation_id: `gen_${ULID}`,
      media: { ...readyMedia, status: "degraded" as const },
    };
    expect(RealtimeEventSchema.parse(e).type).toBe("images.degraded");
  });

  it("parses gen.text.delta", () => {
    const e: unknown = {
      ...base,
      type: "gen.text.delta",
      generation_id: `gen_${ULID}`,
      listing_id: `lst_${ULID}`,
      field: "title",
      delta: "Hel",
    };
    const parsed = RealtimeEventSchema.parse(e);
    expect(parsed.type).toBe("gen.text.delta");
    if (parsed.type === "gen.text.delta") expect(parsed.field).toBe("title");
  });

  it("parses gen.text.done", () => {
    const e: unknown = {
      ...base,
      type: "gen.text.done",
      generation_id: `gen_${ULID}`,
      listing_id: `lst_${ULID}`,
    };
    expect(RealtimeEventSchema.parse(e).type).toBe("gen.text.done");
  });

  it("requires seq and ts on every event", () => {
    const noSeq = { type: "gen.text.done", generation_id: "g", listing_id: "l", ts: base.ts };
    expect(RealtimeEventSchema.safeParse(noSeq).success).toBe(false);
    const badTs = { ...base, ts: "not-a-date", type: "gen.text.done", generation_id: "g", listing_id: "l" };
    expect(RealtimeEventSchema.safeParse(badTs).success).toBe(false);
  });

  it("rejects an unknown type and a negative seq", () => {
    expect(RealtimeEventSchema.safeParse({ ...base, type: "nope" }).success).toBe(false);
    expect(
      RealtimeEventSchema.safeParse({
        ...base,
        seq: -1,
        type: "tracking_event",
        orderId: "o",
        state: "s",
        label: "l",
      }).success,
    ).toBe(false);
  });

  it("narrows exhaustively over the union", () => {
    const handle = (e: RealtimeEvent): string => {
      switch (e.type) {
        case "tracking_event":
          return e.orderId;
        case "geo_position":
          return e.position.orderId;
        case "images.ready":
        case "images.degraded":
          return e.media.status;
        case "gen.text.delta":
          return e.field;
        case "gen.text.done":
          return e.listing_id;
      }
    };
    expect(
      handle({ ...base, type: "tracking_event", orderId: "ord_x", state: "s", label: "l" }),
    ).toBe("ord_x");
  });
});
