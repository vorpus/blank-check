import {
  type Cart,
  type CartItem,
  type Listing,
  multiplyMoney,
} from "@dopamine/contracts";

/**
 * Pure cart-math helpers — the optimistic transforms `useCart` applies before the
 * server reconciles (doc 03 §9.2). Kept side-effect-free so they're unit-testable
 * without React/TanStack Query.
 */

/** Sum line totals into a subtotal (integer cents, single currency). */
export function recomputeSubtotal(
  items: CartItem[],
  currency: string,
): Cart["subtotal"] {
  const cents = items.reduce((sum, it) => sum + it.lineTotal.amount_cents, 0);
  return { amount_cents: cents, currency };
}

/** Apply a new line-item set and re-derive subtotal/version optimistically. */
export function withItems(cart: Cart, items: CartItem[]): Cart {
  return {
    ...cart,
    items,
    subtotal: recomputeSubtotal(items, cart.currency),
    version: cart.version + 1,
    updatedAt: new Date().toISOString(),
  };
}

/** Optimistic add: bump an existing line's qty, or append a provisional line. */
export function applyAdd(cart: Cart, listing: Listing, qty: number): Cart {
  const existing = cart.items.find((it) => it.listingId === listing.id);
  if (existing) {
    const items = cart.items.map((it) =>
      it.id === existing.id
        ? {
            ...it,
            qty: it.qty + qty,
            lineTotal: multiplyMoney(it.unitPrice, it.qty + qty),
          }
        : it,
    );
    return withItems(cart, items);
  }
  const provisional: CartItem = {
    id: `optimistic_${listing.id}`,
    listingId: listing.id,
    title: listing.title,
    qty,
    unitPrice: listing.price,
    lineTotal: multiplyMoney(listing.price, qty),
  };
  return withItems(cart, [...cart.items, provisional]);
}

/** Optimistic set-quantity for a line. */
export function applySetQty(cart: Cart, itemId: string, qty: number): Cart {
  const items = cart.items.map((it) =>
    it.id === itemId
      ? { ...it, qty, lineTotal: multiplyMoney(it.unitPrice, qty) }
      : it,
  );
  return withItems(cart, items);
}

/** Optimistic remove of a line. */
export function applyRemove(cart: Cart, itemId: string): Cart {
  return withItems(
    cart,
    cart.items.filter((it) => it.id !== itemId),
  );
}
