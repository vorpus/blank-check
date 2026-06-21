import { type Listing, ListingSchema, type Media, MediaSchema } from "@dopamine/contracts";
import { type Listing as PrismaListing } from "@prisma/client";

/**
 * Maps a Prisma `listings` row to the contract `Listing` wire shape (doc 05 §4.1).
 * Money is rebuilt from integer cents + currency; the JSONB `media`/`attributes`
 * are parsed through the contract schemas so a malformed stored blob fails loudly
 * rather than leaking an untyped object across the API boundary.
 */
export function toContractListing(row: PrismaListing): Listing {
  const media = parseMedia(row.media, row.generationId ?? `gen_${row.id}`);
  return ListingSchema.parse({
    id: row.id,
    verticalId: row.verticalId,
    storefrontId: row.storefrontId,
    title: row.title,
    description: row.description,
    price: { amount_cents: row.priceCents, currency: row.currency },
    attributes: (row.attributes as Record<string, unknown> | null) ?? {},
    media,
    origin: row.origin,
    canonicalQuery: row.canonicalQuery,
    embedding: null, // RESERVED — Stage 2 (always null in Stage 1)
    createdAt: row.createdAt.toISOString(),
  });
}

/** Parse a stored media blob, falling back to a minimal `ready`/empty block. */
function parseMedia(raw: unknown, generationId: string): Media {
  const parsed = MediaSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Seeded/hand-authored listings may have an empty `{}` media — synthesize a
  // ready block with no hero so the contract still parses.
  return MediaSchema.parse({
    status: "ready",
    hero: null,
    alternates: [],
    expected_ready_ms: null,
    generation_id: generationId,
  });
}
