import {
  AddCartItemSchema,
  CartItemSchema,
  CartSchema,
  UpdateCartItemSchema,
  type AddCartItem,
  type CartItem,
  type Cart,
  type UpdateCartItem,
} from "@dopamine/contracts";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/**
 * Cart wire shapes (doc 01 §7). The canonical shapes now live in
 * `@dopamine/contracts` (`CartSchema`/`Cart`, promoted in Milestone 4a) — ONE
 * source of truth for runtime validation AND the OpenAPI document AND the SDK's
 * cart methods. This module re-exports them under the api's historical names
 * (`CartView`*) so the service/controller stay unchanged, and adds the
 * api-internal query DTO. Money rides as `{ amount_cents, currency }` everywhere
 * (doc 05 §6.1); `version` carries the optimistic-concurrency cursor.
 */

// Re-export the promoted contract schemas under the api's existing names so the
// cart service/controller keep compiling against `CartView`/`CartItemView`.
export const CartItemViewSchema = CartItemSchema;
export type CartItemView = CartItem;
export const CartViewSchema = CartSchema;
export type CartView = Cart;
export {
  AddCartItemSchema,
  UpdateCartItemSchema,
  type AddCartItem,
  type UpdateCartItem,
};

/** GET /v1/cart query. */
export const CartQuerySchema = z.object({
  storefrontId: z.string().optional(),
});
export type CartQuery = z.infer<typeof CartQuerySchema>;

export class CartViewDto extends createZodDto(CartViewSchema) {}
export class AddCartItemDto extends createZodDto(AddCartItemSchema) {}
export class UpdateCartItemDto extends createZodDto(UpdateCartItemSchema) {}
