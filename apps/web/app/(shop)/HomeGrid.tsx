"use client";

import { GridSkeleton } from "./GridSkeleton";

import { StateMessage, errorMessage } from "@/components/common/StateMessage";
import { ResultsGrid } from "@/components/listing/ResultsGrid";
import { useSearch } from "@/hooks/useSearch";


/**
 * Default browse grid for the home screen — an empty-query search returns the
 * seeded catalog page (doc 03 §2.1). Same `useSearch` hook the results screen
 * uses, just with an empty term.
 */
export function HomeGrid() {
  const { data, isLoading, isError, error } = useSearch("");

  if (isLoading) return <GridSkeleton />;
  if (isError) {
    return (
      <StateMessage title="Couldn’t load the catalog" detail={errorMessage(error)} />
    );
  }
  if (!data) return <GridSkeleton />;

  return <ResultsGrid result={data} pendingSkeletons={0} />;
}
