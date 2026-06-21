import { z } from "zod";

/**
 * Prefixed-ULID entity identifiers (charter / doc 05 §6.2).
 *
 * Format: `<prefix>_<26-char Crockford base32 ULID>` — sortable, collision-resistant,
 * self-describing in logs. Crockford base32 excludes the letters I, L, O, U.
 *
 * The §4 wire schemas type IDs as plain `z.string()` for forward-compat (the format
 * is enforced server-side); `prefixedId(prefix)` is the strict validator available
 * where strict parsing is wanted (e.g. server input pipes, tests).
 */
export const ID_PREFIXES = {
  user: "usr",
  device: "dev",
  storefront: "sto",
  listing: "lst",
  order: "ord",
  orderItem: "oit",
  cart: "crt",
  cartItem: "cit",
  generation: "gen",
} as const;

/** Logical entity names that have a canonical ID prefix. */
export type IdEntity = keyof typeof ID_PREFIXES;
/** The 3-letter prefix strings, e.g. `"lst"`. */
export type IdPrefix = (typeof ID_PREFIXES)[IdEntity];

/** The ULID body: 26 Crockford base32 chars (no I, L, O, U). */
const ULID_BODY = "[0-9A-HJKMNP-TV-Z]{26}";
const ULID_RE = new RegExp(`^${ULID_BODY}$`);

/**
 * A Zod string schema that validates a prefixed ULID for the given prefix,
 * e.g. `prefixedId("lst")` matches `lst_01J9Z3K8Q0X4M7P2R5T6V8W9Y0`.
 */
export const prefixedId = (prefix: string): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}_${ULID_BODY}$`), {
    message: `must be a "${prefix}_"-prefixed ULID`,
  });

/** True if `value` is a syntactically valid prefixed ULID for `prefix`. */
export const isPrefixedId = (prefix: string, value: unknown): value is string =>
  typeof value === "string" && new RegExp(`^${prefix}_${ULID_BODY}$`).test(value);

/**
 * Format a prefixed id from a bare 26-char ULID body. Throws if the body is not a
 * valid Crockford-base32 ULID — minting helper for tests/seed code, not the wire.
 */
export const formatId = (prefix: string, ulid: string): string => {
  if (!ULID_RE.test(ulid)) {
    throw new Error(`invalid ULID body: ${ulid}`);
  }
  return `${prefix}_${ulid}`;
};

/**
 * Split a prefixed id into `{ prefix, ulid }`, or `null` if it is not a valid
 * prefixed ULID. Pure parse — no allocation of Zod machinery on the hot path.
 */
export const parseId = (value: string): { prefix: string; ulid: string } | null => {
  const idx = value.indexOf("_");
  if (idx <= 0) return null;
  const prefix = value.slice(0, idx);
  const ulid = value.slice(idx + 1);
  if (!ULID_RE.test(ulid)) return null;
  return { prefix, ulid };
};
