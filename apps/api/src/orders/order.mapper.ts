import { type Order, OrderSchema } from "@dopamine/contracts";
import { type Order as PrismaOrder, type OrderItem as PrismaOrderItem } from "@prisma/client";

import { type Vertical } from "../vertical-registry/vertical.types";

type OrderRow = PrismaOrder & { items: PrismaOrderItem[] };

/**
 * Maps a Prisma `orders` row (+ its items) onto the vertical-agnostic contract
 * `Order` (doc 05 §4.1, charter §4.1). The `display.stages` and `trackingMode`
 * come from the vertical's TrackingProvider — NOT hardcoded — so the client
 * renders the lifecycle from data and carries no retail state enum. `streamUrl`
 * points the client at the SSE gateway; `capabilities.liveLocation` is the
 * vertical's flag (false for retail's timeline mode).
 */
export function toContractOrder(row: OrderRow, vertical: Vertical): Order {
  return OrderSchema.parse({
    id: row.id,
    verticalId: row.verticalId,
    storefrontId: row.storefrontId,
    state: row.state,
    items: row.items.map((it) => ({
      id: it.id,
      listingId: it.listingId,
      titleSnapshot: it.titleSnapshot,
      unitPriceSnapshot: { amount_cents: it.unitPriceSnapshot, currency: row.currency },
      qty: it.qty,
    })),
    total: { amount_cents: row.totalCents, currency: row.currency },
    display: {
      stages: vertical.tracking.stagesFor(row.state),
      trackingMode: vertical.tracking.trackingMode,
    },
    capabilities: { liveLocation: vertical.tracking.liveLocation },
    streamUrl: `/v1/orders/${row.id}/stream`,
    placedAt: row.placedAt.toISOString(),
  });
}
