import { z } from "zod";

/**
 * Cross-cutting enums (doc 05 §4.1 / §4.2). Reserved values are present now so the
 * wire shape is frozen; Stage 1 only ever emits the non-reserved subset (§8.2).
 */

/** `"map"` is RESERVED for Stage 7 (food); Stage 1 only emits `"timeline"`. */
export const TrackingModeSchema = z.enum(["timeline", "map"]);
export type TrackingMode = z.infer<typeof TrackingModeSchema>;

export const MediaStatusSchema = z.enum([
  "generating_text", // listing text still streaming/forming
  "generating_media", // text ready, hero image still rendering
  "ready", // fully materialized
  "degraded", // usable but media fell back (placeholder kept)
]);
export type MediaStatus = z.infer<typeof MediaStatusSchema>;

export const OriginSchema = z.enum([
  "exact_cache", // canon_key hit in Redis → existing listing reused
  "semantic_reuse", // pgvector near-dup reuse (RESERVED — Stage 2)
  "seed", // from the seeded starter catalog
  "generated", // freshly produced by the provider
]);
export type Origin = z.infer<typeof OriginSchema>;

export const GenerationStatusSchema = z.enum(["pending", "ready", "degraded"]);
export type GenerationStatus = z.infer<typeof GenerationStatusSchema>;
