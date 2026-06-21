"use client";

import { type Listing } from "@dopamine/contracts";
import Link from "next/link";

import { MediaImage } from "@/components/common/MediaImage";
import { Price } from "@/components/common/Price";
import { useGenerationMedia } from "@/hooks/useGenerationMedia";

/**
 * `ListingCard` — the DATA-DRIVEN grid card (doc 03 §5.1, §6).
 *
 * Renders entirely from the `Listing` fields + `media.status`. It does NOT branch
 * on `verticalId` and knows nothing about "retail" — title/description/price come
 * from the listing, the image decision comes from `media`. Text renders
 * immediately (don't wait for media). A card mid-generation subscribes on its
 * `media.generation_id` so the placeholder→final swap lands here automatically.
 *
 * The whole card is a link as soon as it has an `id` — orderable/openable even
 * while `generating_media` (doc 03 §2.2, §6.2). Only a truly absent listing
 * (handled by the parent grid as a SkeletonCard) blocks interaction.
 */
export function ListingCard({ listing }: { listing: Listing }) {
  // Subscribe to the image swap while this listing is mid-generation. The hook
  // no-ops once status is ready/degraded (it still listens, but no frames arrive),
  // and patches the cache so this card re-renders with the final hero.
  const subscribe =
    listing.media.status === "generating_text" ||
    listing.media.status === "generating_media";
  useGenerationMedia(
    subscribe ? listing.media.generation_id : null,
    subscribe ? listing.id : null,
  );

  return (
    <Link
      href={`/listing/${listing.id}`}
      className="group block overflow-hidden rounded-xl border border-neutral-200 transition-colors hover:border-neutral-400"
    >
      <MediaImage
        media={listing.media}
        alt={listing.title}
        className="aspect-square w-full rounded-none"
      />
      <div className="space-y-1 p-3">
        <h3 className="line-clamp-1 text-sm font-medium text-neutral-900">
          {listing.title}
        </h3>
        <p className="line-clamp-2 text-xs text-neutral-500">
          {listing.description}
        </p>
        <Price
          amount={listing.price}
          className="block pt-1 text-sm font-semibold text-neutral-900"
        />
      </div>
    </Link>
  );
}
