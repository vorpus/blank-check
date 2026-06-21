import { OrderSchema, TrackingSnapshotSchema } from "@dopamine/contracts";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/**
 * Orders DTOs (doc 01 §7.3). The wire shapes (`Order`, `TrackingSnapshot`) are
 * the canonical `@dopamine/contracts` schemas — one source of truth for runtime
 * validation AND the OpenAPI document. Place-order takes the cart implicitly (the
 * active cart for the device user); the only place-time input is the
 * `Idempotency-Key` header + an optional `storefrontId`.
 */
export const PlaceOrderSchema = z.object({
  storefrontId: z.string().optional(),
});
export type PlaceOrder = z.infer<typeof PlaceOrderSchema>;

export class PlaceOrderDto extends createZodDto(PlaceOrderSchema) {}
export class OrderResponseDto extends createZodDto(OrderSchema) {}
export class OrderListResponseDto extends createZodDto(z.array(OrderSchema)) {}
export class TrackingSnapshotResponseDto extends createZodDto(TrackingSnapshotSchema) {}
