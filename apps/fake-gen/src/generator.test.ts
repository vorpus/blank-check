import { GenerationResultSchema } from "@dopamine/contracts";
import { describe, expect, it } from "vitest";

import { buildBatch, buildResult, finalMedia, type BuildOptions } from "./generator.js";

const opts: BuildOptions = {
  publicBaseUrl: "http://fake-gen:8090",
  expectedReadyMs: 1500,
  status: "generating_media",
};

describe("generator — determinism", () => {
  it("produces byte-identical results for the same (query, vertical, variant, genId)", () => {
    const a = buildResult("ladder", "retail", 0, "gen_X", opts);
    const b = buildResult("ladder", "retail", 0, "gen_X", opts);
    expect(a).toEqual(b);
  });

  it("produces a different title/price for a different variant", () => {
    const v0 = buildResult("ladder", "retail", 0, "gen_X", opts);
    const v1 = buildResult("ladder", "retail", 1, "gen_X", opts);
    expect(v0.listing.title).not.toEqual(v1.listing.title);
  });

  it("produces different content for a different query", () => {
    const ladder = buildResult("ladder", "retail", 0, "gen_X", opts);
    const lamp = buildResult("lamp", "retail", 0, "gen_X", opts);
    expect(ladder.listing.title).not.toEqual(lamp.listing.title);
  });
});

describe("generator — contract conformance", () => {
  it("every fast-path result parses against GenerationResultSchema", () => {
    for (const q of ["ladder", "lamp", "blue widget", "a thing with spaces"]) {
      const r = buildResult(q, "retail", 0, "gen_X", opts);
      expect(() => GenerationResultSchema.parse(r)).not.toThrow();
    }
  });

  it("listing_id is null and origin is generated (charter §5.5.1/§5.5.5)", () => {
    const r = buildResult("ladder", "retail", 0, "gen_X", opts);
    expect(r.listing_id).toBeNull();
    expect(r.origin).toBe("generated");
    expect(r.listing.origin).toBe("generated");
  });

  it("fast-path media is generating_media with a placeholder hero + expected_ready_ms", () => {
    const r = buildResult("ladder", "retail", 0, "gen_X", opts);
    expect(r.status).toBe("generating_media");
    expect(r.listing.media.status).toBe("generating_media");
    expect(r.listing.media.hero?.url).toContain("/img/ph/");
    expect(r.listing.media.expected_ready_ms).toBe(1500);
    expect(r.listing.media.hero?.blurhash).toBeNull();
  });

  it("price is integer cents (Money), never floats", () => {
    const r = buildResult("ladder", "retail", 0, "gen_X", opts);
    expect(Number.isInteger(r.listing.price.amount_cents)).toBe(true);
    expect(r.listing.price.currency).toBe("USD");
  });
});

describe("generator — grid distinctness", () => {
  it("returns N distinct variants (different titles)", () => {
    const batch = buildBatch(
      { query: "ladder", vertical: "retail", count: 8 },
      (v) => `gen_X:g${String(v)}`,
      opts,
    );
    expect(batch).toHaveLength(8);
    const titles = new Set(batch.map((r) => r.listing.title));
    expect(titles.size).toBe(8);
  });

  it("the batch is deterministic across calls", () => {
    const a = buildBatch({ query: "lamp", vertical: "retail", count: 5 }, (v) => `g${String(v)}`, opts);
    const b = buildBatch({ query: "lamp", vertical: "retail", count: 5 }, (v) => `g${String(v)}`, opts);
    expect(a).toEqual(b);
  });
});

describe("generator — final media", () => {
  it("ready outcome yields a final hero + alternate", () => {
    const m = finalMedia("ladder", 0, "gen_X:g0", "http://fake-gen:8090", "ready");
    expect(m.status).toBe("ready");
    expect(m.hero?.url).toContain("/img/fin/");
    expect(m.alternates).toHaveLength(1);
  });

  it("degraded outcome keeps the placeholder hero (still usable)", () => {
    const m = finalMedia("ladder", 0, "gen_X:g0", "http://fake-gen:8090", "degraded");
    expect(m.status).toBe("degraded");
    expect(m.hero?.url).toContain("/img/ph/");
    expect(m.alternates).toHaveLength(0);
  });
});
