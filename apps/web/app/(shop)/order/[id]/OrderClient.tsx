"use client";

import Link from "next/link";

import { ConnectionBadge } from "@/components/common/ConnectionBadge";
import { OrderSummary } from "@/components/common/OrderSummary";
import { StateMessage, errorMessage } from "@/components/common/StateMessage";
import { TrackingRenderer } from "@/components/tracking/registry";
import { useOrder } from "@/hooks/useOrder";
import { useTracking } from "@/hooks/useTracking";

/**
 * Order / tracking island (doc 03 §2.6, §5, §7).
 *
 *   - `useOrder(id)` reads the order (and is the polling-fallback's cache target).
 *   - `useTracking(id)` owns the SSE lifecycle, snapshot/replay, seq-ordered
 *     apply, and polling fallback (all inside the SDK `TrackingClient`); it folds
 *     events into the SAME `useOrder` cache, so the timeline advances live.
 *   - `<TrackingRenderer>` dispatches on `display.trackingMode` (registry) and
 *     `<TimelineRenderer>` maps `display.stages[]` — NO hardcoded state enum.
 *
 * Reload mid-flight ⇒ a fresh snapshot resyncs (the SDK re-catches up on mount).
 */
export function OrderClient({ id }: { id: string }) {
  const { data: order, isLoading, isError, error } = useOrder(id);
  const { mode } = useTracking(id);

  if (isLoading) return <StateMessage title="Loading your order…" />;
  if (isError) {
    return (
      <StateMessage title="Couldn’t load this order" detail={errorMessage(error)}>
        <Link href="/orders" className="text-sm underline">
          Back to orders
        </Link>
      </StateMessage>
    );
  }
  if (!order) return <StateMessage title="Loading your order…" />;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Order tracking</h1>
          <p className="text-xs text-neutral-400">#{order.id}</p>
        </div>
        <ConnectionBadge mode={mode} />
      </div>

      <div className="grid gap-8 md:grid-cols-2">
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-neutral-500">Progress</h2>
          {/* Registry dispatch on display.trackingMode → TimelineRenderer maps stages */}
          <TrackingRenderer order={order} />
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-neutral-500">Summary</h2>
          <OrderSummary order={order} />
        </section>
      </div>

      <Link href="/orders" className="inline-block text-sm text-neutral-500 underline">
        ← All orders
      </Link>
    </div>
  );
}
