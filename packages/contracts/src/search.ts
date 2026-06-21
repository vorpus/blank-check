import { z } from "zod";

import { GenerationStatusSchema } from "./enums.js";
import { ListingSchema } from "./listing.js";

/**
 * Search result envelope (doc 05 §4.1). Search returns a *populated grid*, not a
 * single listing. Each card carries its own `media.status`, so the grid renders
 * skeleton → placeholder → ready per card. The `generation` block is present on a
 * miss (a generation is in flight); `null` on a pure cache hit.
 */
export const SearchGenerationSchema = z.object({
  status: GenerationStatusSchema, // "pending" | "ready" | "degraded"
  canonicalQuery: z.string(),
  generationId: z.string(), // gen_…
  pollAfterMs: z.number().int().nonnegative(),
});
export type SearchGeneration = z.infer<typeof SearchGenerationSchema>;

export const SearchResultSchema = z.object({
  listings: z.array(ListingSchema),
  generation: SearchGenerationSchema.nullable().default(null),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;
