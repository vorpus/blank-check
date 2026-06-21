import { SearchResults } from "./SearchResults";

import { SearchBox } from "@/components/common/SearchBox";


/**
 * Results grid (doc 03 §2.2). Same screen as home, query-driven via `?q=`. The
 * shell is server-rendered; the grid is the identity-gated client island.
 *
 * `searchParams` is async in Next 15.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? "").trim();

  return (
    <div className="space-y-6">
      <SearchBox initialQuery={query} />
      <SearchResults query={query} />
    </div>
  );
}
