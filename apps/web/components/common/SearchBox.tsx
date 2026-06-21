"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Search input. Submitting navigates to `/search?q=…` (the results screen is the
 * same screen, query-driven — doc 03 §2.2). A real <form> so Enter submits and
 * the control is keyboard-accessible.
 */
export function SearchBox({ initialQuery = "" }: { initialQuery?: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initialQuery);

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = q.trim();
        router.push(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search");
      }}
      className="flex w-full gap-2"
    >
      <label htmlFor="search-input" className="sr-only">
        Search the catalog
      </label>
      <input
        id="search-input"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search anything — try “a brass ladder”"
        className="flex-1 rounded-lg border border-neutral-300 px-4 py-2.5 text-sm outline-none focus:border-neutral-900"
        autoComplete="off"
      />
      <button
        type="submit"
        className="rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-700"
      >
        Search
      </button>
    </form>
  );
}
