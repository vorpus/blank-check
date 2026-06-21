import { type Cart, type Listing } from "@dopamine/contracts";
import { describe, expect, it } from "vitest";

import { applyAdd, applyRemove, applySetQty, recomputeSubtotal } from "./cartMath";

/**
 * Optimistic cart math (doc 03 §9.2): add bumps qty / appends a line, set-qty
 * re-derives the line total, remove drops the line, and the subtotal always
 * re-sums the lines (integer cents). These are the transforms applied INSTANTLY
 * before the server reconciles.
 */

function listing(id: string, cents: number): Listing {
  return {
    id,
    verticalId: "retail",
    storefrontId: "sto_1",
    title: `Item ${id}`,
    description: "",
    price: { amount_cents: cents, currency: "USD" },
    attributes: {},
    media: {
      status: "ready",
      hero: null,
      alternates: [],
      expected_ready_ms: null,
      generation_id: "gen_1",
    },
    origin: "seed",
    canonicalQuery: null,
    embedding: null,
    createdAt: "2026-06-20T00:00:00.000Z",
  };
}

function emptyCart(): Cart {
  return {
    id: "crt_1",
    storefrontId: "sto_1",
    status: "active",
    version: 0,
    items: [],
    subtotal: { amount_cents: 0, currency: "USD" },
    currency: "USD",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

describe("cartMath", () => {
  it("applyAdd appends a provisional line and re-sums the subtotal", () => {
    const cart = applyAdd(emptyCart(), listing("lst_a", 500), 2);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]?.qty).toBe(2);
    expect(cart.items[0]?.lineTotal.amount_cents).toBe(1000);
    expect(cart.subtotal.amount_cents).toBe(1000);
    expect(cart.version).toBe(1); // optimistic version bump
  });

  it("applyAdd bumps an existing line rather than duplicating it", () => {
    let cart = applyAdd(emptyCart(), listing("lst_a", 500), 1);
    cart = applyAdd(cart, listing("lst_a", 500), 2);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]?.qty).toBe(3);
    expect(cart.subtotal.amount_cents).toBe(1500);
  });

  it("applySetQty recomputes the line total and subtotal", () => {
    let cart = applyAdd(emptyCart(), listing("lst_a", 250), 1);
    const itemId = cart.items[0]!.id;
    cart = applySetQty(cart, itemId, 4);
    expect(cart.items[0]?.qty).toBe(4);
    expect(cart.items[0]?.lineTotal.amount_cents).toBe(1000);
    expect(cart.subtotal.amount_cents).toBe(1000);
  });

  it("applyRemove drops the line and the subtotal follows", () => {
    let cart = applyAdd(emptyCart(), listing("lst_a", 250), 2);
    cart = applyAdd(cart, listing("lst_b", 1000), 1);
    expect(cart.subtotal.amount_cents).toBe(1500);
    cart = applyRemove(cart, cart.items[0]!.id);
    expect(cart.items).toHaveLength(1);
    expect(cart.subtotal.amount_cents).toBe(1000);
  });

  it("recomputeSubtotal sums multiple lines", () => {
    const cart = applyAdd(
      applyAdd(emptyCart(), listing("lst_a", 300), 2),
      listing("lst_b", 150),
      3,
    );
    expect(recomputeSubtotal(cart.items, "USD").amount_cents).toBe(600 + 450);
  });
});
