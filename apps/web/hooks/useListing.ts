"use client";

import { type Listing } from "@dopamine/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useIdentity } from "@/app/providers";
import { qk } from "@/lib/queryKeys";
import { getApi } from "@/lib/sdk";

/**
 * `useListing(id)` — `GET /v1/listings/{id}` (doc 03 §4). The listing detail
 * island uses this to hydrate the RSC-rendered shell and to drive the live media
 * swap (the card subscribes on `listing.media.generation_id` if mid-generation).
 *
 * `initialData` lets the server-rendered listing seed the cache so there's no
 * fetch waterfall on first paint of the detail page.
 */
export function useListing(
  id: string,
  initialData?: Listing,
): UseQueryResult<Listing> {
  const { ready } = useIdentity();
  return useQuery({
    queryKey: qk.listing(id),
    queryFn: () => getApi().listings.get(id),
    enabled: ready || initialData !== undefined,
    ...(initialData !== undefined ? { initialData } : {}),
    // `ready` listings are effectively immutable; only the media block mutates,
    // and that arrives via the generation stream (setQueryData), not a refetch.
    staleTime: 60_000,
  });
}
