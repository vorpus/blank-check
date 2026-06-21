/**
 * Representative fixtures for tests. Not part of the public surface (not
 * re-exported from `index.ts`) — these are authoring aids only.
 */
import type { Listing, Order } from "./index.js";

const ULID = "01J9Z3K8Q0X4M7P2R5T6V8W9Y0";

export const listingFixture: Listing = {
  id: `lst_${ULID}`,
  verticalId: "retail",
  storefrontId: `sto_${ULID}`,
  title: "A sturdy wooden ladder",
  description: "Six-foot folding ladder, pine.",
  price: { amount_cents: 8999, currency: "USD" },
  attributes: { color: "natural", height_ft: 6 },
  media: {
    status: "ready",
    hero: {
      url: "http://minio.local/ladder.png",
      kind: "image",
      blurhash: null,
      aspect_ratio: 1,
    },
    alternates: [],
    expected_ready_ms: null,
    generation_id: `gen_${ULID}`,
  },
  origin: "generated",
  canonicalQuery: "wooden ladder",
  embedding: null,
  createdAt: "2026-06-21T12:00:00Z",
};

export const orderFixture: Order = {
  id: `ord_${ULID}`,
  verticalId: "retail",
  storefrontId: `sto_${ULID}`,
  state: "shipped",
  items: [
    {
      id: `oit_${ULID}`,
      listingId: `lst_${ULID}`,
      titleSnapshot: "A sturdy wooden ladder",
      unitPriceSnapshot: { amount_cents: 8999, currency: "USD" },
      qty: 2,
    },
  ],
  total: { amount_cents: 17998, currency: "USD" },
  display: {
    stages: [
      { key: "placed", label: "Placed", reached: true, current: false },
      { key: "shipped", label: "Shipped", reached: true, current: true },
      { key: "delivered", label: "Delivered", reached: false, current: false },
    ],
    trackingMode: "timeline",
  },
  capabilities: { liveLocation: false },
  streamUrl: `/v1/orders/ord_${ULID}/stream`,
  placedAt: "2026-06-21T11:00:00Z",
};
