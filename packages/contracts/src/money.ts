import { z } from "zod";

/**
 * Money — integer cents + ISO-4217 currency, never floats (doc 05 §4.1 / §6.1).
 * `{ amount_cents: 1299, currency: "USD" }` == $12.99. Display formatting is a
 * client concern; the wire is always this shape.
 */
export const MoneySchema = z.object({
  amount_cents: z.number().int(),
  currency: z.string().length(3),
});
export type Money = z.infer<typeof MoneySchema>;

/** Construct a `Money` from integer cents (throws on non-integer input). */
export const money = (amount_cents: number, currency = "USD"): Money =>
  MoneySchema.parse({ amount_cents, currency });

/** True iff two amounts are the same currency. */
export const sameCurrency = (a: Money, b: Money): boolean => a.currency === b.currency;

/** Add two same-currency amounts. Throws on currency mismatch. */
export const addMoney = (a: Money, b: Money): Money => {
  if (!sameCurrency(a, b)) {
    throw new Error(`currency mismatch: ${a.currency} != ${b.currency}`);
  }
  return { amount_cents: a.amount_cents + b.amount_cents, currency: a.currency };
};

/** Multiply an amount by an integer quantity (e.g. line item total). */
export const multiplyMoney = (a: Money, qty: number): Money => {
  if (!Number.isInteger(qty)) {
    throw new Error(`qty must be an integer: ${qty}`);
  }
  return { amount_cents: a.amount_cents * qty, currency: a.currency };
};
