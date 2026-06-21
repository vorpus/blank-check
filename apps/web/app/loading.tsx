import { SkeletonCard } from "@/components/listing/SkeletonCard";

/**
 * Route-segment skeleton for App Router transitions (doc 03 §3). Functional only;
 * the choreographed transition is Stage 3 `[→S3]`.
 */
export default function Loading() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
