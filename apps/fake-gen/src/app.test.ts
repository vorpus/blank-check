import {
  GenerationResultSchema,
  MediaSchema,
} from "@dopamine/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildApp } from "./app.js";
import { loadConfig, type FakeGenConfig } from "./config.js";
import {
  GenerateResponseSchema,
  MediaPollResponseSchema,
} from "./wire.js";

function makeApp(overrides: Partial<FakeGenConfig> = {}) {
  const cfg: FakeGenConfig = {
    ...loadConfig({}),
    publicBaseUrl: "http://fake-gen:8090",
    logLevel: "silent",
    ...overrides,
  };
  return buildApp(cfg);
}

/** The two error envelopes the routes can emit — typed so tests stay `any`-free. */
const ValidationErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
const ProviderErrorSchema = z.object({
  error: z.object({ type: z.string(), message: z.string(), retryable: z.boolean() }),
});

const baseBody = {
  query: "ladder",
  vertical: "retail",
  deviceId: "dev_TEST",
  requestId: "req_TEST",
};

describe("POST /generate", () => {
  const app = makeApp({ mediaDelayMs: 50 });

  it("returns a contract-valid GenerateResponse with one result by default", async () => {
    const res = await app.inject({ method: "POST", url: "/generate", payload: baseBody });
    expect(res.statusCode).toBe(200);
    const parsed = GenerateResponseSchema.parse(res.json());
    expect(parsed.results).toHaveLength(1);
    expect(parsed.origin).toBe("generated");
    expect(parsed.status).toBe("generating_media");
    // each result independently parses against the canonical schema
    for (const r of parsed.results) {
      expect(() => GenerationResultSchema.parse(r)).not.toThrow();
      expect(r.listing_id).toBeNull();
    }
  });

  it("honors count for the grid and returns distinct variants", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/generate",
      payload: { ...baseBody, count: 6 },
    });
    const parsed = GenerateResponseSchema.parse(res.json());
    expect(parsed.results).toHaveLength(6);
    const titles = new Set(parsed.results.map((r) => r.listing.title));
    expect(titles.size).toBe(6);
  });

  it("is deterministic: same request → same response", async () => {
    const a = await app.inject({ method: "POST", url: "/generate", payload: baseBody });
    const b = await app.inject({ method: "POST", url: "/generate", payload: baseBody });
    expect(a.json()).toEqual(b.json());
  });

  it("rejects an invalid body with a validation_error envelope", async () => {
    const res = await app.inject({ method: "POST", url: "/generate", payload: { vertical: "retail" } });
    expect(res.statusCode).toBe(400);
    expect(ValidationErrorSchema.parse(res.json()).error.code).toBe("validation_error");
  });
});

describe("POST /generate-grid", () => {
  const app = makeApp({ mediaDelayMs: 50 });
  it("requires count", async () => {
    const res = await app.inject({ method: "POST", url: "/generate-grid", payload: baseBody });
    expect(res.statusCode).toBe(400);
  });
  it("returns count distinct variants", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/generate-grid",
      payload: { ...baseBody, count: 4 },
    });
    const parsed = GenerateResponseSchema.parse(res.json());
    expect(parsed.results).toHaveLength(4);
  });
});

describe("GET /media/:generationId — two-phase progression", () => {
  it("reports generating_media before the delay, then ready after", async () => {
    const app = makeApp({ mediaDelayMs: 80 });
    const gen = await app.inject({ method: "POST", url: "/generate", payload: baseBody });
    const { generation_id } = GenerateResponseSchema.parse(gen.json());

    const early = await app.inject({ method: "GET", url: `/media/${generation_id}` });
    const earlyParsed = MediaPollResponseSchema.parse(early.json());
    expect(earlyParsed.outcome).toBe("generating_media");

    await new Promise((r) => setTimeout(r, 120));

    const late = await app.inject({ method: "GET", url: `/media/${generation_id}` });
    const lateParsed = MediaPollResponseSchema.parse(late.json());
    expect(lateParsed.outcome).toBe("ready");
    expect(lateParsed.items.length).toBeGreaterThan(0);
    for (const item of lateParsed.items) {
      expect(() => MediaSchema.parse(item.media)).not.toThrow();
      expect(item.media.status).toBe("ready");
      expect(item.media.hero?.url).toContain("/img/fin/");
    }
  });
});

describe("GET /media — forced degraded path", () => {
  it("reproducibly resolves degraded with the placeholder kept", async () => {
    const app = makeApp({ mediaDelayMs: 10, failureRate: 1 });
    const gen = await app.inject({ method: "POST", url: "/generate", payload: baseBody });
    const { generation_id } = GenerateResponseSchema.parse(gen.json());
    await new Promise((r) => setTimeout(r, 30));
    const poll = await app.inject({ method: "GET", url: `/media/${generation_id}` });
    const parsed = MediaPollResponseSchema.parse(poll.json());
    expect(parsed.outcome).toBe("degraded");
    for (const item of parsed.items) {
      expect(item.media.status).toBe("degraded");
      expect(item.media.hero?.url).toContain("/img/ph/");
    }
  });
});

describe("FAKE_MEDIA_MODE=inline", () => {
  it("returns ready immediately with no async schedule", async () => {
    const app = makeApp({ mediaMode: "inline" });
    const res = await app.inject({ method: "POST", url: "/generate", payload: baseBody });
    const parsed = GenerateResponseSchema.parse(res.json());
    expect(parsed.status).toBe("ready");
    expect(parsed.results[0]?.listing.media.status).toBe("ready");
    expect(parsed.results[0]?.listing.media.hero?.url).toContain("/img/fin/");
  });
});

describe("FAKE_FAIL_GENERATE=1", () => {
  it("returns the generation_failed error envelope", async () => {
    const app = makeApp({ failGenerate: true });
    const res = await app.inject({ method: "POST", url: "/generate", payload: baseBody });
    expect(res.statusCode).toBe(502);
    const err = ProviderErrorSchema.parse(res.json()).error;
    expect(err.type).toBe("generation_failed");
    expect(err.retryable).toBe(true);
  });
});

describe("GET /healthz", () => {
  it("returns ok", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(z.object({ status: z.string() }).parse(res.json()).status).toBe("ok");
  });
});

describe("GET /img/:dir/:file — deterministic SVG bytes", () => {
  it("serves stable SVG bytes for a valid placeholder key", async () => {
    const app = makeApp();
    const gen = await app.inject({ method: "POST", url: "/generate", payload: baseBody });
    const url = GenerateResponseSchema.parse(gen.json()).results[0]?.listing.media.hero?.url;
    expect(url).toBeDefined();
    const path = new URL(url as string).pathname;
    const a = await app.inject({ method: "GET", url: path });
    const b = await app.inject({ method: "GET", url: path });
    expect(a.statusCode).toBe(200);
    expect(a.headers["content-type"]).toContain("image/svg+xml");
    expect(a.body).toEqual(b.body); // deterministic bytes
    expect(a.body).toContain("<svg");
  });

  it("404s on a malformed key", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/img/ph/not-a-key.svg" });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /generate/stream — optional COLD token stream", () => {
  it("emits gen.start, deltas, and gen.text.done", async () => {
    const app = makeApp({ streamDeltaMs: 0 });
    const res = await app.inject({
      method: "GET",
      url: `/generate/stream?query=ladder&vertical=retail&deviceId=dev_T&requestId=req_T`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("event: gen.start");
    expect(res.body).toContain("event: gen.text.delta");
    expect(res.body).toContain("event: gen.text.done");
  });
});
