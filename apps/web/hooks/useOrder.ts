"use client";

import { type Order } from "@dopamine/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { useIdentity } from "@/app/providers";
import { qk } from "@/lib/queryKeys";
import { getApi } from "@/lib/sdk";

/**
 * `useOrder(id)` — `GET /v1/orders/{id}` (doc 03 §4, §7.4). This is the SAME
 * query the polling fallback re-reads, so live SSE updates and polling converge
 * on ONE cache entry (`useTracking` writes here via `setQueryData`).
 */
export function useOrder(id: string): UseQueryResult<Order> {
  const { ready } = useIdentity();
  return useQuery({
    queryKey: qk.order(id),
    queryFn: () => getApi().orders.get(id),
    enabled: ready && id.length > 0,
    // The order mutates live; SSE writes the cache directly, so a manual refetch
    // is rarely needed — but keep it modest so a focus/reload resyncs.
    staleTime: 2_000,
  });
}

/** `useOrders()` — `GET /v1/orders` (doc 03 §2.7). Device-scoped, recent first. */
export function useOrders(): UseQueryResult<Order[]> {
  const { ready } = useIdentity();
  return useQuery({
    queryKey: qk.orders(),
    queryFn: () => getApi().orders.list(),
    enabled: ready,
    staleTime: 5_000,
  });
}

/**
 * `usePlaceOrder()` — idempotent place-order (doc 03 §9.3). Each placement mints a
 * fresh `Idempotency-Key` so a retry of the SAME placement never double-creates.
 * On success: seed the order cache, invalidate cart + orders, hand back the order.
 */
export function usePlaceOrder(): UseMutationResult<Order, unknown, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => {
      // A per-placement key — stable for one click, distinct across placements.
      const key =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `idem_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      return getApi().orders.place({}, key);
    },
    onSuccess: (order) => {
      qc.setQueryData(qk.order(order.id), order);
      void qc.invalidateQueries({ queryKey: qk.cart() });
      void qc.invalidateQueries({ queryKey: qk.orders() });
    },
  });
}
