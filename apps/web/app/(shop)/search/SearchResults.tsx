"use client";

import { GridSkeleton } from "../GridSkeleton";

import { StateMessage, errorMessage } from "@/components/common/StateMessage";
import { ResultsGrid } from "@/components/listing/ResultsGrid";
import { useSearch } from "@/hooks/useSearch";


/**
 * The results-grid island (doc 03 §2.2, §6). On a MISS, `useSearch` returns a
 * `generation` hint and (initially) few/no listings → `ResultsGrid` renders
 * skeleton cards INSTANTLY, which upgrade as the fake pipeline produces listings
 * and images (each card self-subscribes on its `generation_id`). An exact
 * re-search is an instant cache hit → all-ready listings, no skeletons.
 */
export function SearchResults({ query }: { query: string }) {
  const { data, isLoading, isError, error, isFetching } = useSearch(query);

  if (isLoading) return <GridSkeleton />;
  if (isError) {
    return <StateMessage title="Search failed" detail={errorMessage(error)} />;
  }
  if (!data) return <GridSkeleton />;

  const generating = data.generation?.status === "pending";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">
          {query ? (
            <>
              Results for <span className="font-semibold">“{query}”</span>
            </>
          ) : (
            "Browse"
          )}
        </h1>
        {generating && (
          <span className="text-xs text-neutral-500" role="status">
            summoning new listings…
          </span>
        )}
      </div>

      <ResultsGrid result={data} />

      {isFetching && !generating && (
        <p className="text-center text-xs text-neutral-400">updating…</p>
      )}
    </div>
  );
}
