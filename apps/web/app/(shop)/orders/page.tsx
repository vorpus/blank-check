"use client";

import { type Order } from "@dopamine/contracts";
import Link from "next/link";

import { Price } from "@/components/common/Price";
import { StateMessage, errorMessage } from "@/components/common/StateMessage";
import { useOrders } from "@/hooks/useOrder";

/**
 * Order history (doc 03 §2.7). Device-scoped, most recent first. Each row shows a
 * summary + the order's CURRENT stage — derived from that order's own
 * `display.stages` (the one marked `current`), never a hardcoded label — and links
 * into its tracking screen.
 */
export default function OrdersPage() {
  const { data: orders, isLoading, isError, error } = useOrders();

  if (isLoading) return <StateMessage title="Loading your orders…" />;
  if (isError) {
    return <StateMessage title="Couldn’t load your orders" detail={errorMessage(error)} />;
  }
  if (!orders || orders.length === 0) {
    return (
      <StateMessage title="No orders yet" detail="Place an order to track it here.">
        <Link href="/" className="text-sm underline">
          Start searching
        </Link>
      </StateMessage>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Your orders</h1>
      <ul className="divide-y divide-neutral-100 border-y border-neutral-200">
        {orders.map((order) => (
          <li key={order.id}>
            <Link
              href={`/order/${order.id}`}
              className="flex items-center gap-4 py-4 hover:bg-neutral-50"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-neutral-900">
                  {summarizeItems(order)}
                </p>
                <p className="text-xs text-neutral-400">
                  #{order.id} · {new Date(order.placedAt).toLocaleString()}
                </p>
              </div>
              <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700">
                {currentStageLabel(order)}
              </span>
              <Price
                amount={order.total}
                className="w-20 text-right text-sm font-semibold text-neutral-900"
              />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The current stage label from `display.stages` (data-driven, no enum). */
function currentStageLabel(order: Order): string {
  const current = order.display.stages.find((s) => s.current);
  const lastReached = [...order.display.stages].reverse().find((s) => s.reached);
  return current?.label ?? lastReached?.label ?? "—";
}

function summarizeItems(order: Order): string {
  const first = order.items[0];
  if (!first) return "Order";
  const extra = order.items.length - 1;
  return extra > 0
    ? `${first.titleSnapshot} + ${String(extra)} more`
    : first.titleSnapshot;
}
