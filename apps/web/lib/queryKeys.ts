/**
 * Query-key factory (doc 03 §9.1) — the single source of invalidation truth.
 * Every hook reads/writes the cache through these so invalidations can't drift.
 */
export const qk = {
  search: (q: string) => ["search", q] as const,
  listing: (id: string) => ["listing", id] as const,
  cart: () => ["cart"] as const,
  order: (id: string) => ["order", id] as const,
  orders: () => ["orders"] as const,
} as const;
