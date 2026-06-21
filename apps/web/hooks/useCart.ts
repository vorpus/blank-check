"use client";

import { type Cart, type Listing } from "@dopamine/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { useIdentity } from "@/app/providers";
import { applyAdd, applyRemove, applySetQty } from "@/lib/cartMath";
import { qk } from "@/lib/queryKeys";
import { getApi } from "@/lib/sdk";

/**
 * `useCart()` — the active device cart + optimistic mutations (doc 03 §4, §9.2).
 *
 * Add / set-qty / remove follow the `onMutate → onError → onSettled` pattern:
 * snapshot the cart, apply the optimistic change (pure helpers in `lib/cartMath`),
 * roll back on error, and invalidate to reconcile with the server. The cart
 * updates INSTANTLY; the fly-to-cart animation + badge bounce + haptic are
 * Stage 3 `[→S3]`.
 */

export interface UseCartResult {
  query: UseQueryResult<Cart>;
  /** Total quantity across lines (the nav badge count). */
  count: number;
  addItem: (listing: Listing, qty?: number) => void;
  setQty: (itemId: string, qty: number) => void;
  removeItem: (itemId: string) => void;
  isMutating: boolean;
}

export function useCart(): UseCartResult {
  const { ready } = useIdentity();
  const qc = useQueryClient();
  const api = getApi();

  const query = useQuery({
    queryKey: qk.cart(),
    queryFn: () => api.cart.get(),
    enabled: ready,
    // Cart freshness matters; keep it short.
    staleTime: 5_000,
  });

  interface OptimisticCtx {
    prev: Cart | undefined;
  }

  /**
   * Shared optimistic scaffold: snapshot → apply(prev, vars) → rollback →
   * reconcile. The transform reads `vars` from `onMutate`'s argument (not the
   * mutation's `.variables`, which would create a circular type self-reference).
   */
  function optimistic<V>(apply: (prev: Cart, vars: V) => Cart) {
    return {
      onMutate: async (vars: V): Promise<OptimisticCtx> => {
        await qc.cancelQueries({ queryKey: qk.cart() });
        const prev = qc.getQueryData<Cart>(qk.cart());
        if (prev) qc.setQueryData<Cart>(qk.cart(), apply(prev, vars));
        return { prev };
      },
      onError: (_err: unknown, _vars: V, ctx?: OptimisticCtx) => {
        if (ctx?.prev) qc.setQueryData<Cart>(qk.cart(), ctx.prev);
      },
      onSettled: () => {
        void qc.invalidateQueries({ queryKey: qk.cart() });
      },
    };
  }

  const addMutation = useMutation({
    mutationFn: (vars: { listing: Listing; qty: number }) =>
      api.cart.addItem({ listingId: vars.listing.id, qty: vars.qty }),
    ...optimistic<{ listing: Listing; qty: number }>((prev, v) =>
      applyAdd(prev, v.listing, v.qty),
    ),
  });

  const setQtyMutation = useMutation({
    mutationFn: (vars: { itemId: string; qty: number }) =>
      api.cart.updateItem(vars.itemId, { qty: vars.qty }),
    ...optimistic<{ itemId: string; qty: number }>((prev, v) =>
      applySetQty(prev, v.itemId, v.qty),
    ),
  });

  const removeMutation = useMutation({
    mutationFn: (vars: { itemId: string }) => api.cart.removeItem(vars.itemId),
    ...optimistic<{ itemId: string }>((prev, v) => applyRemove(prev, v.itemId)),
  });

  const items = query.data?.items ?? [];
  const count = items.reduce((sum, it) => sum + it.qty, 0);

  return {
    query,
    count,
    addItem: (listing, qty = 1) => addMutation.mutate({ listing, qty }),
    setQty: (itemId, qty) => setQtyMutation.mutate({ itemId, qty }),
    removeItem: (itemId) => removeMutation.mutate({ itemId }),
    isMutating:
      addMutation.isPending ||
      setQtyMutation.isPending ||
      removeMutation.isPending,
  };
}
