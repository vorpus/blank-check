import { z } from "zod";

import { OriginSchema } from "./enums.js";
import { MediaSchema } from "./media.js";
import { MoneySchema } from "./money.js";

/**
 * Listing (doc 05 §4.1). Vertical-agnostic: per-vertical data rides in
 * `attributes` (JSONB). `embedding` is RESERVED for Stage 2 (pgvector semantic
 * dedup) — always `null` in Stage 1 (§8.2). IDs are typed as `z.string()` for
 * forward-compat; the strict prefixed-ULID validators live in `ids.ts`.
 */
export const ListingSchema = z.object({
  id: z.string(), // lst_…
  verticalId: z.string(), // "retail" in Stage 1 (open string — fwd-compat)
  storefrontId: z.string(), // sto_…
  title: z.string(),
  description: z.string(),
  price: MoneySchema,
  attributes: z.record(z.string(), z.unknown()).default({}), // per-vertical JSONB
  media: MediaSchema,
  origin: OriginSchema, // how this listing came to exist
  canonicalQuery: z.string().nullable().default(null),
  embedding: z.array(z.number()).nullable().default(null), // RESERVED (Stage 2)
  createdAt: z.iso.datetime(),
});
export type Listing = z.infer<typeof ListingSchema>;
