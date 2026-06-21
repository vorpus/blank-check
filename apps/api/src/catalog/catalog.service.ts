import { type Listing, type Media } from "@dopamine/contracts";
import { Injectable } from "@nestjs/common";
import { type Prisma } from "@prisma/client";

import { NotFoundError } from "../common/errors";
import { mintId } from "../common/ids";
import { EventBus } from "../events/event-bus.service";
import { PrismaService } from "../prisma/prisma.service";

import { type Category } from "./catalog.dto";
import { toContractListing } from "./listing.mapper";

/** Fields the generation gateway hands the catalog to persist a generated listing. */
export interface GeneratedListingFields {
  title: string;
  description: string;
  priceCents: number;
  currency: string;
  attributes: Record<string, unknown>;
}

/** One generated listing to write back. `isAnchor` → owns the canonicalQuery dedup key. */
export interface GeneratedListingInput {
  storefrontId: string;
  verticalId: string;
  canonicalQuery: string;
  /** The fake-gen batch generation id (correlates the async images.ready swap). */
  generationId: string;
  fields: GeneratedListingFields;
  media: Media;
  imageUrls: string[];
  /**
   * Exactly one listing per batch is the dedup anchor: it owns `(storefrontId,
   * canonicalQuery)` (the exact-cache target + idempotency key). The rest are
   * distinct grid fillers with `canonicalQuery = null` so they don't collide on
   * the unique constraint.
   */
  isAnchor: boolean;
}

/**
 * CatalogService (doc 01 §2, §4.4) — owns `storefronts` / `categories` / `listings`.
 * Read paths (getListing/listCategories) and the GENERATED-listing write path. The
 * write-back is the idempotent, transactional seam called by the generation gateway.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * Resolve a storefront + its vertical. Passing null returns the first (default)
   * storefront — Stage 1 has one ("Mega-Mart"), so search/cart can omit it.
   */
  async resolveStorefront(storefrontId: string | null): Promise<{ id: string; verticalId: string }> {
    const row = storefrontId
      ? await this.prisma.storefront.findUnique({ where: { id: storefrontId } })
      : await this.prisma.storefront.findFirst({ orderBy: { name: "asc" } });
    if (!row) throw new NotFoundError("storefront not found", { storefrontId });
    return { id: row.id, verticalId: row.verticalId };
  }

  /** Listing detail (GET /v1/listings/{id}). */
  async getListing(id: string): Promise<Listing> {
    const row = await this.prisma.listing.findUnique({ where: { id } });
    if (!row) throw new NotFoundError(`listing not found: ${id}`, { id });
    return toContractListing(row);
  }

  /** Load many listings by id, preserving the requested order. */
  async getListings(ids: string[]): Promise<Listing[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.listing.findMany({ where: { id: { in: ids } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [toContractListing(row)] : [];
    });
  }

  /** Category tree for a storefront (GET /v1/storefronts/{id}/categories). */
  async listCategories(storefrontId: string): Promise<Category[]> {
    const cats = await this.prisma.category.findMany({
      where: { storefrontId },
      orderBy: { name: "asc" },
    });
    return cats.map((c) => ({ id: c.id, name: c.name, slug: c.slug, parentId: c.parentId }));
  }

  /**
   * Transactional, idempotent generated-listing write-back (doc 01 §4.4). For the
   * dedup ANCHOR the unique `(storefrontId, canonicalQuery)` makes a retried write a
   * no-op upsert (DLQ redelivery / double-miss → no dup row). Filler variants get a
   * fresh row each time but are only written once (the lock collapses concurrent
   * misses upstream). Image bytes are ingested to MinIO BEFORE this commits (the
   * gateway does that), so no row references a missing blob.
   *
   * Writes a `listing.generated` outbox event in the SAME transaction.
   */
  async writeBackGenerated(input: GeneratedListingInput): Promise<Listing> {
    const status = mediaStatusToListingStatus(input.media.status);

    const row = await this.prisma.$transaction(async (tx) => {
      let written: Awaited<ReturnType<typeof tx.listing.upsert>>;
      if (input.isAnchor) {
        written = await tx.listing.upsert({
          where: {
            storefrontId_canonicalQuery: {
              storefrontId: input.storefrontId,
              canonicalQuery: input.canonicalQuery,
            },
          },
          create: {
            id: mintId("listing"),
            storefrontId: input.storefrontId,
            verticalId: input.verticalId,
            title: input.fields.title,
            description: input.fields.description,
            priceCents: input.fields.priceCents,
            currency: input.fields.currency,
            attributes: input.fields.attributes as Prisma.InputJsonValue,
            media: input.media,
            imageUrls: input.imageUrls,
            origin: "generated",
            status,
            canonicalQuery: input.canonicalQuery,
            generationId: input.generationId,
          },
          // Retry-safe: refresh media/images, keep the row + its id stable.
          update: {
            media: input.media,
            imageUrls: input.imageUrls,
            status,
            generationId: input.generationId,
          },
        });
      } else {
        // Non-anchor filler: a distinct grid card, no dedup key.
        written = await tx.listing.create({
          data: {
            id: mintId("listing"),
            storefrontId: input.storefrontId,
            verticalId: input.verticalId,
            title: input.fields.title,
            description: input.fields.description,
            priceCents: input.fields.priceCents,
            currency: input.fields.currency,
            attributes: input.fields.attributes as Prisma.InputJsonValue,
            media: input.media,
            imageUrls: input.imageUrls,
            origin: "generated",
            status,
            canonicalQuery: null,
            generationId: input.generationId,
          },
        });
      }

      // Write the outbox event in the SAME transaction as the listing so the
      // listing row and its `listing.generated` event commit atomically — no
      // dual-write window where one lands without the other (mirrors
      // enrich.service.ts).
      await this.eventBus.publishTx(tx, {
        type: "listing.generated",
        listingId: written.id,
        storefrontId: input.storefrontId,
        canonicalQuery: input.canonicalQuery,
      });

      return written;
    });

    return toContractListing(row);
  }

  /** Flip a generated listing's media (called by the enrich processor on ready/degraded). */
  async updateMediaByGenerationId(
    listingId: string,
    media: Media,
    imageUrls: string[],
  ): Promise<void> {
    await this.prisma.listing.update({
      where: { id: listingId },
      data: {
        media: media,
        imageUrls,
        status: mediaStatusToListingStatus(media.status),
      },
    });
  }
}

/** Map a contract MediaStatus onto the listing's coarse status column. */
function mediaStatusToListingStatus(media: Media["status"]): string {
  switch (media) {
    case "ready":
      return "ready";
    case "degraded":
      return "degraded";
    case "generating_text":
      return "skeleton";
    case "generating_media":
    default:
      return "placeholder";
  }
}
