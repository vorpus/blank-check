import { describe, it, expect } from "vitest";

import { listingFixture, orderFixture } from "./fixtures.js";
import { ListingSchema } from "./listing.js";
import { OrderSchema } from "./order.js";

describe("Listing round-trip", () => {
  it("parses a representative listing fixture", () => {
    const parsed = ListingSchema.parse(listingFixture);
    expect(parsed).toEqual(listingFixture);
  });

  it("applies defaults for reserved/optional fields", () => {
    const minimal = {
      id: "lst_01J9Z3K8Q0X4M7P2R5T6V8W9Y0",
      verticalId: "retail",
      storefrontId: "sto_01J9Z3K8Q0X4M7P2R5T6V8W9Y0",
      title: "x",
      description: "y",
      price: { amount_cents: 100, currency: "USD" },
      media: {
        status: "generating_text",
        hero: null,
        generation_id: "gen_01J9Z3K8Q0X4M7P2R5T6V8W9Y0",
      },
      origin: "generated",
      createdAt: "2026-06-21T12:00:00Z",
    };
    const parsed = ListingSchema.parse(minimal);
    // §8.2 reserved defaults
    expect(parsed.embedding).toBeNull();
    expect(parsed.canonicalQuery).toBeNull();
    expect(parsed.attributes).toEqual({});
    expect(parsed.media.alternates).toEqual([]);
    expect(parsed.media.expected_ready_ms).toBeNull();
  });

  it("rejects a bad listing (float price, bad datetime)", () => {
    expect(
      ListingSchema.safeParse({ ...listingFixture, price: { amount_cents: 1.5, currency: "USD" } })
        .success,
    ).toBe(false);
    expect(ListingSchema.safeParse({ ...listingFixture, createdAt: "not-a-date" }).success).toBe(
      false,
    );
  });
});

describe("Order round-trip", () => {
  it("parses a representative order fixture", () => {
    const parsed = OrderSchema.parse(orderFixture);
    expect(parsed).toEqual(orderFixture);
  });

  it("rejects a bad order (qty <= 0)", () => {
    const bad = {
      ...orderFixture,
      items: [{ ...orderFixture.items[0], qty: 0 }],
    };
    expect(OrderSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an order missing the display block", () => {
    const { display: _omit, ...rest } = orderFixture;
    expect(OrderSchema.safeParse(rest).success).toBe(false);
  });
});
