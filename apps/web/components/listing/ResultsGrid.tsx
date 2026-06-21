"use client";

import { type SearchResult } from "@dopamine/contracts";

import { ListingCard } from "./ListingCard";
import { SkeletonCard } from "./SkeletonCard";

/**
 * The blended cache-vs-generate grid (doc 03 §2.2, §6.1).
 *
 * Ready + mid-generation listings render as `ListingCard`s (the card itself
 * handles its media state). When a generation is in flight (`result.generation`)
 * but the grid hasn't been populated yet — a true MISS — we render skeleton cards
 * INSTANTLY so the grid is never empty while content materializes. An exact
 * re-search returns all-ready listings and no `generation` hint → no skeletons.
 */
export function ResultsGrid({
  result,
  /** How many skeletons to pad with while a generation is pending. */
  pendingSkeletons = 6,
}: {
  result: SearchResult;
  pendingSkeletons?: number;
}) {
  const { listings, generation } = result;

  // A generation is "in flight" until it reaches a terminal status.
  const generating = generation !== null && generation.status === "pending";

  // Pad with skeletons only when generating AND the grid is short — so a populated
  // grid mid-generation doesn't grow phantom skeletons under the real cards.
  const skeletonCount = generating
    ? Math.max(0, pendingSkeletons - listings.length)
    : 0;

  if (listings.length === 0 && skeletonCount === 0) {
    return (
      <p className="py-16 text-center text-sm text-neutral-500">
        No results. Try a different search.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {listings.map((listing) => (
        <ListingCard key={listing.id} listing={listing} />
      ))}
      {Array.from({ length: skeletonCount }).map((_, i) => (
        <SkeletonCard key={`sk_${String(i)}`} />
      ))}
    </div>
  );
}
