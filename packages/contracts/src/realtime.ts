import { z } from "zod";

import { MediaSchema } from "./media.js";
import { DisplayBlockSchema } from "./order.js";

/**
 * Realtime events (doc 05 §4.3). Channel `order:{orderId}` carries
 * `tracking_event`; generation swaps ride the same fan-out keyed on
 * `generation_id`. Every event carries a per-order monotonic `seq` and a server
 * `ts`. Client rules: apply in `seq` order, drop `seq <= lastApplied`, catch up
 * on reconnect via snapshot + replay from `seq`.
 */

const EventBaseSchema = z.object({
  seq: z.number().int().nonnegative(), // per-order monotonic, gap-free
  ts: z.iso.datetime(), // server clock — trust over local
});

/** RESERVED (Stage 7, map verticals only). Typed now; never emitted in Stage 1. */
export const GeoPositionSchema = z.object({
  orderId: z.string(),
  lat: z.number(),
  lng: z.number(),
  heading: z.number().nullable().default(null),
});
export type GeoPosition = z.infer<typeof GeoPositionSchema>;

/** order:{orderId} — state changes (Stage 1's live tracking). */
export const TrackingEventSchema = EventBaseSchema.extend({
  type: z.literal("tracking_event"),
  orderId: z.string(),
  state: z.string(), // new state key
  label: z.string(), // human-facing
  display: DisplayBlockSchema.optional(), // server may resend the full stage list
});
export type TrackingEvent = z.infer<typeof TrackingEventSchema>;

/** RESERVED: emitted only by map-tracking verticals (Stage 7). */
export const GeoEventSchema = EventBaseSchema.extend({
  type: z.literal("geo_position"),
  position: GeoPositionSchema,
});
export type GeoEvent = z.infer<typeof GeoEventSchema>;

/** Generation media swaps — keyed on generation_id, ride the same fan-out. */
export const ImagesReadySchema = EventBaseSchema.extend({
  type: z.literal("images.ready"),
  generation_id: z.string(),
  media: MediaSchema, // thin block the client swaps in
});
export type ImagesReady = z.infer<typeof ImagesReadySchema>;

export const ImagesDegradedSchema = EventBaseSchema.extend({
  type: z.literal("images.degraded"),
  generation_id: z.string(),
  media: MediaSchema, // status: "degraded"; hero is the kept placeholder
});
export type ImagesDegraded = z.infer<typeof ImagesDegradedSchema>;

/** Streaming text generation progress (arch 00 §4.2 — COLD search "types out"). */
export const GenTextDeltaSchema = EventBaseSchema.extend({
  type: z.literal("gen.text.delta"),
  generation_id: z.string(),
  listing_id: z.string(),
  field: z.enum(["title", "description"]),
  delta: z.string(),
});
export type GenTextDelta = z.infer<typeof GenTextDeltaSchema>;

export const GenTextDoneSchema = EventBaseSchema.extend({
  type: z.literal("gen.text.done"),
  generation_id: z.string(),
  listing_id: z.string(),
});
export type GenTextDone = z.infer<typeof GenTextDoneSchema>;

/** Discriminated union — every realtime event the client may receive. */
export const RealtimeEventSchema = z.discriminatedUnion("type", [
  TrackingEventSchema,
  GeoEventSchema, // RESERVED
  ImagesReadySchema,
  ImagesDegradedSchema,
  GenTextDeltaSchema,
  GenTextDoneSchema,
]);
export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;

/** The discriminant literal — the set of all realtime event `type` values. */
export type RealtimeEventType = RealtimeEvent["type"];
