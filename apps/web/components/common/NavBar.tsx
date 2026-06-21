"use client";

import Link from "next/link";

import { useCart } from "@/hooks/useCart";

/**
 * Top nav chrome: brand → home, plus entry points to order history and the cart
 * (with a live badge count from `useCart`). Rendered in the root layout, inside
 * the client providers so the cart hook can read the query cache.
 */
export function NavBar() {
  const { count } = useCart();

  return (
    <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/90 backdrop-blur">
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          dopamine
        </Link>
        <div className="flex items-center gap-5 text-sm">
          <Link href="/orders" className="text-neutral-600 hover:text-neutral-900">
            Orders
          </Link>
          <Link
            href="/cart"
            className="relative text-neutral-600 hover:text-neutral-900"
            aria-label={`Cart, ${String(count)} item${count === 1 ? "" : "s"}`}
          >
            Cart
            {count > 0 && (
              <span className="absolute -right-4 -top-2 grid h-5 min-w-5 place-items-center rounded-full bg-neutral-900 px-1 text-[11px] font-medium text-white">
                {count}
              </span>
            )}
          </Link>
        </div>
      </nav>
    </header>
  );
}
