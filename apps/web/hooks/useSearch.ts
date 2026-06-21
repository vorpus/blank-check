"use client";

import { type SearchResult } from "@dopamine/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useIdentity } from "@/app/providers";
import { qk } from "@/lib/queryKeys";
import { getApi } from "@/lib/sdk";

/**
 * A non-empty token the api treats as "browse the default catalog". The live
 * `/v1/search` requires `q` to be non-empty (`q.min(1)`), and its canonicalizer
 * collapses a lone space / very-short query to a broad catalog match (no
 * generation). So the home/browse grid searches `BROWSE_QUERY` rather than `""`.
 *
 * RECONCILIATION (flagged): doc 03 §2.1 specs "empty query → seeded catalog", but
 * the as-built api rejects an empty `q`. Sending a space is the minimal honest
 * adapter; a dedicated `GET /v1/catalog`/browse endpoint would be cleaner — team
 * decision for a contract follow-up.
 */
export const BROWSE_QUERY = " ";

/**
 * `useSearch(q)` — `GET /v1/search` (doc 03 §4, §6.1).
 *
 * Returns the blended grid: `listings[]` (ready cache hits + placeholders mid-
 * generation, each carrying its own `media.status` + `media.generation_id`) and
 * an optional `generation` hint (present on a miss). The cards self-subscribe to
 * their generation stream (see `useGenerationMedia`) — this hook only fetches the
 * blended snapshot.
 *
 * An empty/whitespace query browses the default seeded catalog (cold open is
 * never empty).
 */
export function useSearch(q: string): UseQueryResult<SearchResult> {
  const { ready } = useIdentity();
  const trimmed = q.trim();
  // Browse mode (empty input) → the catalog-browse token the api accepts.
  const query = trimmed.length > 0 ? trimmed : BROWSE_QUERY;

  return useQuery({
    queryKey: qk.search(query),
    queryFn: () => getApi().search({ q: query }),
    // Gate on identity so the first call carries a bearer (search is authed).
    enabled: ready,
    // A miss returns a `generation` hint; keep the grid fresh-ish but not chatty —
    // per-card materialization rides the generation stream, not refetch.
    staleTime: 15_000,
  });
}
