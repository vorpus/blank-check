/**
 * Skeleton card shown on a search MISS while the fake pipeline produces listings
 * (doc 03 §6.1). Static placeholders only — the shimmer/cascade is Stage 3
 * `[→S3]`. Reserves the same footprint as `ListingCard` so the grid doesn't jump
 * when real cards fill in.
 */
export function SkeletonCard() {
  return (
    <div
      className="overflow-hidden rounded-xl border border-neutral-200"
      aria-hidden="true"
    >
      <div className="aspect-square w-full bg-neutral-100" />
      <div className="space-y-2 p-3">
        <div className="h-4 w-3/4 rounded bg-neutral-100" />
        <div className="h-3 w-1/2 rounded bg-neutral-100" />
        <div className="h-4 w-1/4 rounded bg-neutral-100" />
      </div>
    </div>
  );
}
