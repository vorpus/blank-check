import { type Money } from "@dopamine/contracts";

/**
 * Format a `Money` (integer cents + ISO-4217) for display. Formatting is a
 * client concern (the wire is always `{ amount_cents, currency }`, doc 05 §6.1).
 * Uses `Intl.NumberFormat`; falls back to a plain string if the currency code is
 * unknown to the runtime so a bad code never throws in render.
 */
export function formatMoney(m: Money, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: m.currency,
    }).format(m.amount_cents / 100);
  } catch {
    return `${(m.amount_cents / 100).toFixed(2)} ${m.currency}`;
  }
}
