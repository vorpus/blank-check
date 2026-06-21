import { z } from "zod";

import { MediaStatusSchema, OriginSchema } from "./enums.js";
import { ListingSchema } from "./listing.js";

/**
 * The generation seam (doc 05 §4.2). The `fake-gen` service (doc 02) implements
 * `GenerationProvider`; the backend owns canonicalization, the exact-cache, the
 * generation lock, idempotency, image ingestion, and the transactional catalog
 * write. Stage 1 fakes only the *content* but honors every field/state.
 */

export const GenerationRequestSchema = z.object({
  query: z.string(), // raw user query
  vertical: z.string(), // "retail"
  deviceId: z.string(), // dev_… (anon identity)
  locale: z.string().default("en-US").optional(),
  requestId: z.string(), // idempotency / correlation id
});
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;

/**
 * Fast-path response — returned synchronously so search never blocks.
 *
 * Reconciliation note (charter §5.5.1): the canonical correlation key is
 * `generation_id`. The backend mints listing ids during the transactional
 * persist, so a provider may legitimately not know the final listing id yet —
 * `listing_id` is nullable here to honor that. Within `@dopamine/contracts` the
 * shape stays permissive; doc 01/02 enforce their side's invariants.
 */
export const GenerationResultSchema = z.object({
  listing_id: z.string().nullable().default(null), // lst_… (backend-minted; null from fake-gen)
  generation_id: z.string(), // gen_… — keys the async images.ready/degraded
  origin: OriginSchema,
  status: MediaStatusSchema, // generating_text | generating_media | ready | degraded
  listing: ListingSchema, // full listing incl. its `media` block
});
export type GenerationResult = z.infer<typeof GenerationResultSchema>;

/** Input to the optional batch grid fill (arch 00 §4.2). */
export const GenerationGridRequestSchema = GenerationRequestSchema.extend({
  count: z.number().int().positive(),
});
export type GenerationGridRequest = z.infer<typeof GenerationGridRequestSchema>;

/**
 * The seam the AI track implements (doc 05 §4.2). The async media completion
 * (`images.ready` / `images.degraded`) is NOT a method here — it rides the
 * realtime fan-out keyed on `generation_id` (see `realtime.ts`).
 */
export interface GenerationProvider {
  /** Fast path: produce (or reuse) a listing synchronously; media may still be generating. */
  generateListing(input: GenerationRequest): Promise<GenerationResult>;
  /** Optional batch fill for the blended search grid. Stage 1: simple form. */
  generateGrid?(input: GenerationGridRequest): Promise<GenerationResult[]>;
}
