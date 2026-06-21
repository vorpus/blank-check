"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { Price } from "@/components/common/Price";
import { StateMessage, errorMessage } from "@/components/common/StateMessage";
import { useCart } from "@/hooks/useCart";
import { usePlaceOrder } from "@/hooks/useOrder";

/**
 * Checkout (doc 03 §2.5). An order summary + a minimal ANONYMOUS checkout — no
 * login, no real payment (charter §1, §6.3). Placeholder shipping/contact block
 * (fake) + Place order. Placement is idempotent (`Idempotency-Key`, doc 03 §9.3);
 * on success we navigate to the order/tracking screen. The celebration is Stage 3.
 */
export default function CheckoutPage() {
  const router = useRouter();
  const { query } = useCart();
  const { data: cart, isLoading, isError, error } = query;
  const place = usePlaceOrder();

  if (isLoading) return <StateMessage title="Loading checkout…" />;
  if (isError) {
    return <StateMessage title="Couldn’t load checkout" detail={errorMessage(error)} />;
  }
  if (!cart || cart.items.length === 0) {
    return (
      <StateMessage title="Nothing to check out" detail="Your cart is empty.">
        <Link href="/" className="text-sm underline">
          Back to search
        </Link>
      </StateMessage>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Checkout</h1>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-neutral-500">Order summary</h2>
        <div className="rounded-lg border border-neutral-200">
          <ul className="divide-y divide-neutral-100">
            {cart.items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex-1 truncate text-sm text-neutral-800">
                  {item.title}
                </span>
                <span className="text-xs text-neutral-500">×{item.qty}</span>
                <Price
                  amount={item.lineTotal}
                  className="w-20 text-right text-sm text-neutral-700"
                />
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between border-t border-neutral-200 px-4 py-3">
            <span className="text-sm font-medium text-neutral-600">Total</span>
            <Price
              amount={cart.subtotal}
              className="text-base font-semibold text-neutral-900"
            />
          </div>
        </div>
      </section>

      {/* Fake shipping/contact block — anonymous, no real fields collected (§2.5). */}
      <section className="space-y-2 rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-500">
        <p className="font-medium text-neutral-600">Shipping (demo)</p>
        <p>Anonymous device order — no login, no payment. Ships to nowhere fast.</p>
      </section>

      {place.isError && (
        <p className="text-sm text-red-600">{errorMessage(place.error)}</p>
      )}

      <button
        type="button"
        disabled={place.isPending}
        onClick={() => {
          place.mutate(undefined, {
            onSuccess: (order) => router.push(`/order/${order.id}`),
          });
        }}
        className="w-full rounded-lg bg-neutral-900 px-6 py-3 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
      >
        {place.isPending ? "Placing order…" : "Place order"}
      </button>
    </div>
  );
}
