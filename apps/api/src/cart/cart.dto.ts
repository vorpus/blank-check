import { MoneySchema } from "@dopamine/contracts";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/**
 * Cart wire shapes (doc 01 §7). The canonical `@dopamine/contracts` package left
 * `Cart` as an explicit `CartSchema in full impl` placeholder (doc 05 §5), so the
 * cart read shape is declared here as an api-internal Zod DTO — the same pattern
 * the Category tree uses. Money rides as `{ amount_cents, currency }` everywhere
 * (doc 05 §6.1); a `version` field carries the optimistic-concurrency cursor.
 *
 * If/when the web client needs `Cart` cross-platform, this schema is the lift to
 * promote into `@dopamine/contracts` (additive) — its shape is already contract-clean.
 */

export const CartItemViewSchema = z.object({
  id: z.string(), // cit_…
  listingId: z.string(), // lst_…
  title: z.string(), // live listing title (carts reference live listings, doc 01 §1)
  qty: z.number().int().positive(),
  unitPrice: MoneySchema, // snapshot at add-time
  lineTotal: MoneySchema, // unitPrice * qty
});
export type CartItemView = z.infer<typeof CartItemViewSchema>;

export const CartViewSchema = z.object({
  id: z.string(), // crt_…
  storefrontId: z.string(),
  status: z.string(), // "active"
  version: z.number().int().nonnegative(), // optimistic-concurrency cursor (doc 01 §8.2)
  items: z.array(CartItemViewSchema),
  subtotal: MoneySchema, // sum of lineTotals (integer cents)
  currency: z.string().length(3),
  updatedAt: z.iso.datetime(),
});
export type CartView = z.infer<typeof CartViewSchema>;

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

/** GET /v1/cart query. */
export const CartQuerySchema = z.object({
  storefrontId: z.string().optional(),
});
export type CartQuery = z.infer<typeof CartQuerySchema>;

export class CartViewDto extends createZodDto(CartViewSchema) {}
export class AddCartItemDto extends createZodDto(AddCartItemSchema) {}
export class UpdateCartItemDto extends createZodDto(UpdateCartItemSchema) {}
