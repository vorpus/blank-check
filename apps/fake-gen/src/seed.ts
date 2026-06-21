import { createHash } from "node:crypto";

/**
 * Deterministic seeding primitives.
 *
 * Everything fake-gen produces is a pure function of `(query, vertical, variant)`
 * (doc 02 §3): same input → byte-identical output, on every call, every
 * container, forever. No `Math.random()`, no clock, no AI. This is what makes
 * demos reproducible and a re-search stable before the backend cache is warm.
 *
 * STAGE 2 SEAM: this module disappears. The real pipeline draws content from
 * Claude (text) and Flux/gpt-image (images); the determinism guarantee is
 * replaced by the backend's exact-cache. Nothing else in the HTTP contract moves.
 */

/** 32-bit unsigned seed from a sha256 of the namespaced key. */
export function seed(query: string, namespace: string, variant: number): number {
  const h = createHash("sha256").update(`${namespace}::${query}::${variant}`).digest();
  return h.readUInt32BE(0);
}

/**
 * mulberry32 — a tiny, fast, deterministic PRNG. Given one seed it yields a
 * stable stream of values in [0, 1), so we can draw many stable choices from a
 * single seed.
 */
export function rng(s: number): () => number {
  let a = s >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministically pick one element of a non-empty list. */
export function pick<T>(r: () => number, xs: readonly T[]): T {
  // `xs` is always non-empty at the call sites (the word banks); the
  // `noUncheckedIndexedAccess` guard keeps the public type honest.
  const item = xs[Math.floor(r() * xs.length)];
  if (item === undefined) {
    throw new Error("pick() called with an empty list");
  }
  return item;
}

/** A short, stable, hex digest of a key — used to build deterministic image keys. */
export function digestHex(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}
