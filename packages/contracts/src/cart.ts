import { z } from "zod";

import { MoneySchema } from "./money.js";

/**
 * Cart wire shapes (doc 01 §7, doc 05 §5 — PROMOTED in Milestone 4a).
 *
 * Doc 05 §5 originally left `Cart` as a `CartSchema in full impl` placeholder, so
 * Milestone 3b kept the cart read shape api-internal (`CartViewSchema` in
 * `apps/api/src/cart/cart.dto.ts`). The SDK's cart methods need a cross-platform
 * `Cart` type, so the shape is now PROMOTED here as the single source of truth —
 * ADDITIVE within /v1 (a new schema; nothing removed or repurposed, doc 05 §8.1).
 * The api imports `CartSchema` from here; the SDK parses cart responses with it.
 *
 * Money rides as `{ amount_cents, currency }` everywhere (doc 05 §6.1); `version`
 * carries the optimistic-concurrency cursor (doc 01 §8.2).
 */

export const CartItemSchema = z.object({
  id: z.string(), // cit_…
  listingId: z.string(), // lst_…
  title: z.string(), // live listing title (carts reference live listings, doc 01 §1)
  qty: z.number().int().positive(),
  unitPrice: MoneySchema, // snapshot at add-time
  lineTotal: MoneySchema, // unitPrice * qty
});
export type CartItem = z.infer<typeof CartItemSchema>;

export const CartSchema = z.object({
  id: z.string(), // crt_…
  storefrontId: z.string(),
  status: z.string(), // "active"
  version: z.number().int().nonnegative(), // optimistic-concurrency cursor (doc 01 §8.2)
  items: z.array(CartItemSchema),
  subtotal: MoneySchema, // sum of lineTotals (integer cents)
  currency: z.string().length(3),
  updatedAt: z.iso.datetime(),
});
export type Cart = z.infer<typeof CartSchema>;

/** POST /v1/cart/items body. `version` (optional) guards a concurrent edit. */
export const AddCartItemSchema = z.object({
  listingId: z.string(),
  qty: z.number().int().positive().default(1),
  storefrontId: z.string().optional(), // resolves the active cart; default storefront if omitted
  version: z.number().int().nonnegative().optional(), // optimistic-concurrency check
});
export type AddCartItem = z.infer<typeof AddCartItemSchema>;

/** PATCH /v1/cart/items/:id body. `qty` 0 is rejected (use DELETE to remove). */
export const UpdateCartItemSchema = z.object({
  qty: z.number().int().positive(),
  version: z.number().int().nonnegative().optional(),
});
export type UpdateCartItem = z.infer<typeof UpdateCartItemSchema>;
