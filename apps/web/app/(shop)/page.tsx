import { HomeGrid } from "./HomeGrid";

import { SearchBox } from "@/components/common/SearchBox";


/**
 * Home / Search (doc 03 §2.1). A prominent search box over a default browse grid
 * (the empty-query seeded catalog, so a cold open is never empty). The shell is
 * server-rendered; the grid is a client island (identity-gated, cache-driven).
 */
export default function HomePage() {
  return (
    <div className="space-y-8">
      <section className="space-y-3 pt-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          Search anything.
        </h1>
        <p className="text-sm text-neutral-500">
          If it doesn&apos;t exist yet, we&apos;ll summon it.
        </p>
        <SearchBox />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-neutral-500">Browse the catalog</h2>
        <HomeGrid />
      </section>
    </div>
  );
}
