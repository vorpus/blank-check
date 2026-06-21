import { z } from "zod";

import { TrackingModeSchema } from "./enums.js";
import { MoneySchema } from "./money.js";

/**
 * Order, OrderItem, and the presentation-as-data block (doc 05 §4.1).
 * Clients render the lifecycle from `display.stages` and never hardcode a state
 * enum — `Order.state` is an opaque server-validated key, not a client enum.
 */

export const DisplayStageSchema = z.object({
  key: z.string(), // "shipped" — opaque to the client
  label: z.string(), // "Shipped" — server-provided, human-facing
  reached: z.boolean(),
  current: z.boolean().default(false),
});
export type DisplayStage = z.infer<typeof DisplayStageSchema>;

export const DisplayBlockSchema = z.object({
  stages: z.array(DisplayStageSchema), // ordered, server-defined lifecycle
  trackingMode: TrackingModeSchema, // "timeline" in Stage 1
});
export type DisplayBlock = z.infer<typeof DisplayBlockSchema>;

export const CapabilitiesSchema = z.object({
  liveLocation: z.boolean().default(false), // false for retail; true selects geo channel (S7)
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const OrderItemSchema = z.object({
  id: z.string(), // oit_…
  listingId: z.string(), // lst_…
  titleSnapshot: z.string(), // frozen at order time
  unitPriceSnapshot: MoneySchema,
  qty: z.number().int().positive(),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

export const OrderSchema = z.object({
  id: z.string(), // ord_…
  verticalId: z.string(),
  storefrontId: z.string(),
  state: z.string(), // current state key; validated server-side. NOT a client enum.
  items: z.array(OrderItemSchema),
  total: MoneySchema,
  display: DisplayBlockSchema, // ← clients render from THIS
  capabilities: CapabilitiesSchema,
  streamUrl: z.string(), // "/v1/orders/{id}/stream"
  placedAt: z.iso.datetime(),
});
export type Order = z.infer<typeof OrderSchema>;
