import { z } from "zod";

import { MediaStatusSchema } from "./enums.js";

/**
 * Media asset + media block (doc 05 §4.1).
 * `blurhash` is RESERVED-ish — Stage 1 may send a flat placeholder; real blurhash
 * arrives in Stage 2/3 (§8.2).
 */
export const MediaAssetSchema = z.object({
  url: z.url(),
  kind: z.enum(["image", "video"]).default("image"),
  blurhash: z.string().nullable().default(null),
  aspect_ratio: z.number().positive().default(1), // width/height, e.g. 1.0 square
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

export const MediaSchema = z.object({
  status: MediaStatusSchema,
  hero: MediaAssetSchema.nullable(), // null while generating_text
  alternates: z.array(MediaAssetSchema).default([]),
  expected_ready_ms: z.number().int().nonnegative().nullable().default(null), // skeleton hint
  generation_id: z.string(), // gen_… — keys the async images.ready/degraded swap
});
export type Media = z.infer<typeof MediaSchema>;
