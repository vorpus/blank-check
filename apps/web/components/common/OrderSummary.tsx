import { type Order } from "@dopamine/contracts";

import { Price } from "./Price";

/**
 * Compact order item + total summary, shared by the order/tracking screen and the
 * history rows. Items are snapshots frozen at order time (titleSnapshot,
 * unitPriceSnapshot) — we render those, not live listings.
 */
export function OrderSummary({ order }: { order: Order }) {
  return (
    <div className="rounded-lg border border-neutral-200">
      <ul className="divide-y divide-neutral-100">
        {order.items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 px-4 py-3">
            <span className="flex-1 truncate text-sm text-neutral-800">
              {item.titleSnapshot}
            </span>
            <span className="text-xs text-neutral-500">×{item.qty}</span>
            <Price
              amount={item.unitPriceSnapshot}
              className="w-20 text-right text-sm text-neutral-700"
            />
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between border-t border-neutral-200 px-4 py-3">
        <span className="text-sm font-medium text-neutral-600">Total</span>
        <Price
          amount={order.total}
          className="text-base font-semibold text-neutral-900"
        />
      </div>
    </div>
  );
}
