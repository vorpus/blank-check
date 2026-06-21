"use client";

import Link from "next/link";

import { CartLineItem } from "@/components/cart/CartLineItem";
import { Price } from "@/components/common/Price";
import { StateMessage, errorMessage } from "@/components/common/StateMessage";
import { useCart } from "@/hooks/useCart";

/**
 * Cart (doc 03 §2.4). Line items + subtotal + Checkout. Quantity/remove are
 * optimistic (`useCart`). Empty-cart state links back to search.
 */
export default function CartPage() {
  const { query, setQty, removeItem, isMutating } = useCart();
  const { data: cart, isLoading, isError, error } = query;

  if (isLoading) return <StateMessage title="Loading your cart…" />;
  if (isError) {
    return <StateMessage title="Couldn’t load your cart" detail={errorMessage(error)} />;
  }

  if (!cart || cart.items.length === 0) {
    return (
      <StateMessage title="Your cart is empty" detail="Find something to summon.">
        <Link
          href="/"
          className="mt-2 inline-block rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
        >
          Start searching
        </Link>
      </StateMessage>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Cart</h1>

      <div className="divide-y divide-neutral-100 border-y border-neutral-200">
        {cart.items.map((item) => (
          <CartLineItem
            key={item.id}
            item={item}
            disabled={isMutating}
            onSetQty={(qty) => setQty(item.id, qty)}
            onRemove={() => removeItem(item.id)}
          />
        ))}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm text-neutral-500">Subtotal</span>
        <Price
          amount={cart.subtotal}
          className="text-lg font-semibold text-neutral-900"
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <Link href="/" className="text-sm text-neutral-500 underline">
          Continue shopping
        </Link>
        <Link
          href="/checkout"
          className="rounded-lg bg-neutral-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Checkout
        </Link>
      </div>
    </div>
  );
}
