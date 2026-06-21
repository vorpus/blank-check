"use client";

import {
  type Listing,
  type Media,
  type RealtimeEvent,
  type SearchResult,
} from "@dopamine/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useIdentity } from "@/app/providers";
import { qk } from "@/lib/queryKeys";
import { getTracking } from "@/lib/sdk";

/**
 * `useGenerationMedia(generationId, listingId)` — the placeholder→final image
 * swap (doc 03 §4, §6.2/§6.3).
 *
 * Subscribes to `/v1/generation/{generationId}/stream` via the SAME SDK
 * `TrackingClient` core that drives order tracking — one subscription mechanism,
 * two payload kinds. Each `images.ready` / `images.degraded` frame (and any
 * `gen.text.*` deltas, reserved for richer streaming) carries a `media` block we
 * fold into BOTH the listing cache and any search-grid cache that holds this
 * listing, via the same `setQueryData` path tracking uses.
 *
 * `degraded` is NOT an error: the listing stays fully usable; we just keep the
 * placeholder/last image and flip `media.status` to `degraded`.
 *
 * The subscription lifecycle (subscribe on mount, stop on unmount) lives HERE, in
 * the hook, not in the card component (doc 03 §6.3).
 */
export function useGenerationMedia(
  generationId: string | null | undefined,
  listingId: string | null | undefined,
): void {
  const { ready } = useIdentity();
  const qc = useQueryClient();

  useEffect(() => {
    if (!ready || !generationId || !listingId) return;

    const applyMedia = (media: Media): void => {
      // 1) Patch the single-listing cache (detail page).
      qc.setQueryData<Listing>(qk.listing(listingId), (prev) =>
        prev ? { ...prev, media } : prev,
      );

      // 2) Patch every search-grid cache that contains this listing. We can't
      //    know the query string here, so we walk the `["search", *]` caches.
      const caches = qc.getQueriesData<SearchResult>({ queryKey: ["search"] });
      for (const [key, data] of caches) {
        if (!data) continue;
        let changed = false;
        const listings = data.listings.map((l) => {
          if (l.id !== listingId) return l;
          changed = true;
          return { ...l, media };
        });
        if (changed) qc.setQueryData<SearchResult>(key, { ...data, listings });
      }
    };

    const onEvent = (e: RealtimeEvent): void => {
      if (e.type === "images.ready" || e.type === "images.degraded") {
        if (e.generation_id === generationId) applyMedia(e.media);
      }
      // gen.text.* deltas are reserved for richer streaming; Stage 1 renders text
      // as soon as the listing arrives, so we don't need them for correctness.
    };

    const sub = getTracking().trackGeneration(generationId, onEvent);
    return () => sub.stop();
  }, [ready, generationId, listingId, qc]);
}
