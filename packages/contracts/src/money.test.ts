import { describe, it, expect } from "vitest";

import { MoneySchema, money, addMoney, multiplyMoney, sameCurrency } from "./money.js";

describe("Money", () => {
  it("parses integer cents + 3-char currency", () => {
    expect(MoneySchema.parse({ amount_cents: 1299, currency: "USD" })).toEqual({
      amount_cents: 1299,
      currency: "USD",
    });
  });

  it("rejects floats and wrong-length currency", () => {
    expect(MoneySchema.safeParse({ amount_cents: 12.99, currency: "USD" }).success).toBe(false);
    expect(MoneySchema.safeParse({ amount_cents: 1299, currency: "US" }).success).toBe(false);
  });

  it("money() constructs and validates", () => {
    expect(money(500)).toEqual({ amount_cents: 500, currency: "USD" });
    expect(() => money(1.5)).toThrow();
  });

  it("addMoney sums same-currency amounts and rejects mismatches", () => {
    expect(addMoney(money(100), money(250))).toEqual({ amount_cents: 350, currency: "USD" });
    expect(() => addMoney(money(100, "USD"), money(100, "EUR"))).toThrow(/currency mismatch/);
  });

  it("multiplyMoney scales by an integer qty", () => {
    expect(multiplyMoney(money(199), 3)).toEqual({ amount_cents: 597, currency: "USD" });
    expect(() => multiplyMoney(money(199), 1.5)).toThrow();
  });

  it("sameCurrency compares currency codes", () => {
    expect(sameCurrency(money(1, "USD"), money(2, "USD"))).toBe(true);
    expect(sameCurrency(money(1, "USD"), money(2, "EUR"))).toBe(false);
  });
});
