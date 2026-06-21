import { describe, expect, it } from "vitest";

import { CanonicalizerService } from "./canonicalizer.service";

/**
 * Canonicalization is the dedup/lock/cache key (doc 01 §4.1). These tests pin the
 * collapse rules: case, filler words, punctuation, naive singularize — the
 * transformations that make "a ladder", "the Ladders!", "LADDER" one generation.
 */
describe("CanonicalizerService", () => {
  const canon = new CanonicalizerService();

  it("lowercases and trims", () => {
    expect(canon.canon("  LADDER  ")).toBe("ladder");
  });

  it("strips filler words", () => {
    expect(canon.canon("a ladder")).toBe("ladder");
    expect(canon.canon("the ladder please")).toBe("ladder");
  });

  it("strips punctuation", () => {
    expect(canon.canon("ladder!!!")).toBe("ladder");
    expect(canon.canon("step-ladder")).toBe("stepladder");
  });

  it("naively singularizes trailing s", () => {
    expect(canon.canon("ladders")).toBe("ladder");
    expect(canon.canon("the ladders")).toBe("ladder");
  });

  it("collapses several spellings to ONE canonical (the dedup point)", () => {
    const forms = ["a ladder", "the Ladders!", "  LADDER ", "some ladders please"];
    const canons = new Set(forms.map((f) => canon.canon(f)));
    expect(canons.size).toBe(1);
    expect([...canons][0]).toBe("ladder");
  });

  it("derives stable cache/lock/pop keys", () => {
    expect(canon.cacheKey("sto_1", "ladder")).toBe("canon:sto_1:ladder");
    expect(canon.lockKey("sto_1", "ladder")).toBe("gen:lock:sto_1:ladder");
    expect(canon.popKey("sto_1", "ladder")).toBe("pop:sto_1:ladder");
  });
});
