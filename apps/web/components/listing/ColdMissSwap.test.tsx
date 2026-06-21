import {
  type Listing,
  type Media,
  type RealtimeEvent,
  type SearchResult,
} from "@dopamine/contracts";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ResultsGrid } from "./ResultsGrid";

import { qk } from "@/lib/queryKeys";

/**
 * H2 — the cold-miss path returns placeholder LISTINGS synchronously (the api's
 * `GenerationGateway` returns `listings: persisted` with `media.status =
 * generating_media`), NOT an empty `listings[]` with just a hint. So each
 * `ListingCard` subscribes via its own `media.generation_id` and swaps its media
 * to `ready` when an `images.ready` frame lands on that per-listing generation
 * stream. This test pins that end-to-end behavior on the web side: render a cold
 * miss, drive an `images.ready` frame through the (mocked) tracking client, and
 * assert the card's image swaps from the placeholder to the final hero.
 */

// Identity is "ready" so the generation subscription actually attaches.
vi.mock("@/app/providers", () => ({
  useIdentity: () => ({ ready: true, error: null }),
}));

// Capture the per-generation callback the card registers, so the test can emit.
const genCallbacks = new Map<string, (e: RealtimeEvent) => void>();
const stop = vi.fn();
vi.mock("@/lib/sdk", () => ({
  getTracking: () => ({
    trackGeneration: (generationId: string, cb: (e: RealtimeEvent) => void) => {
      genCallbacks.set(generationId, cb);
      return { stop, getMode: () => "live", onModeChange: () => () => {} };
    },
    trackOrder: () => ({ stop, getMode: () => "live", onModeChange: () => () => {} }),
  }),
}));

const GEN_ID = "gen_BATCH:g0";

function placeholderListing(): Listing {
  return {
    id: "lst_cold_1",
    storefrontId: "sto_1",
    verticalId: "retail",
    title: "Generated Ladder",
    description: "A freshly generated listing.",
    price: { amount_cents: 4999, currency: "USD" },
    attributes: {},
    media: {
      status: "generating_media",
      hero: {
        url: "http://minio/placeholder.svg",
        kind: "image",
        blurhash: null,
        aspect_ratio: 1,
      },
      alternates: [],
      expected_ready_ms: 1500,
      generation_id: GEN_ID,
    },
    status: "generating_media",
  } as unknown as Listing;
}

function readyMedia(): Media {
  return {
    status: "ready",
    hero: {
      url: "http://minio/final-ready.svg",
      kind: "image",
      blurhash: null,
      aspect_ratio: 1,
    },
    alternates: [],
    expected_ready_ms: null,
    generation_id: GEN_ID,
  };
}

const SEARCH_QUERY = "ladder";

/** A harness that reads the search cache (as `useSearch` would) and renders it. */
function Harness({ qc }: { qc: QueryClient }): React.JSX.Element {
  const { data } = useQuery<SearchResult>({
    queryKey: qk.search(SEARCH_QUERY),
    queryFn: () => Promise.reject(new Error("seeded, never fetched")),
    initialData: qc.getQueryData<SearchResult>(qk.search(SEARCH_QUERY)),
  });
  return data ? <ResultsGrid result={data} /> : <div>empty</div>;
}

describe("H2 — cold-miss placeholder cards swap to ready via the generation stream", () => {
  beforeEach(() => {
    genCallbacks.clear();
    stop.mockClear();
  });

  it("renders a placeholder card, then swaps its hero to the final image on images.ready", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // Cold miss: placeholder listing + a pending generation hint (the api shape).
    const coldMiss: SearchResult = {
      query: SEARCH_QUERY,
      listings: [placeholderListing()],
      generation: {
        status: "pending",
        canonicalQuery: SEARCH_QUERY,
        generationId: "gen_BATCH",
        pollAfterMs: 1500,
      },
    } as unknown as SearchResult;
    qc.setQueryData(qk.search(SEARCH_QUERY), coldMiss);

    render(
      <QueryClientProvider client={qc}>
        <Harness qc={qc} />
      </QueryClientProvider>,
    );

    // The card is on screen with the PLACEHOLDER hero immediately (text-first).
    const img = await screen.findByAltText("Generated Ladder");
    expect(img).toHaveAttribute("src", "http://minio/placeholder.svg");

    // The card subscribed to its per-listing generation stream.
    await waitFor(() => expect(genCallbacks.has(GEN_ID)).toBe(true));

    // The worker's images.ready frame lands on that stream → media swaps to final.
    const emit = genCallbacks.get(GEN_ID);
    expect(emit).toBeDefined();
    emit?.({
      type: "images.ready",
      seq: 1,
      ts: "2026-06-21T12:00:01.000Z",
      generation_id: GEN_ID,
      media: readyMedia(),
    });

    await waitFor(() =>
      expect(screen.getByAltText("Generated Ladder")).toHaveAttribute(
        "src",
        "http://minio/final-ready.svg",
      ),
    );
  });
});
