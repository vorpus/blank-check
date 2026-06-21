import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, type FakeGenConfig } from "./config.js";
import { GenerationService } from "./service.js";

/**
 * The in-memory `pending` enrichment map must stay BOUNDED (H3) — entries are
 * cheap to recompute, so once past their retention window they're evicted (lazily
 * on `mediaFor` and via the periodic sweep) rather than accumulating forever.
 */

function makeService(overrides: Partial<FakeGenConfig> = {}): GenerationService {
  const cfg: FakeGenConfig = {
    ...loadConfig({}),
    publicBaseUrl: "http://fake-gen:8090",
    logLevel: "silent",
    mediaMode: "twophase",
    mediaDelayMs: 1000,
    textDelayMs: 0,
    ...overrides,
  };
  return new GenerationService(cfg);
}

function gen(svc: GenerationService, i: number): Promise<{ generation_id: string }> {
  return svc.generate({
    query: `q${String(i)}`,
    vertical: "retail",
    deviceId: "dev_TEST",
    requestId: `req_${String(i)}`,
  });
}

describe("GenerationService — pending map is bounded (H3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("evicts an expired entry lazily on the next mediaFor()", async () => {
    const svc = makeService({ mediaDelayMs: 1000 });
    const { generation_id } = await gen(svc, 0);
    expect(svc.pendingSize()).toBe(1);

    // Past readyAt + retention window (floor is 60s; mediaDelayMs*10 = 10s < floor).
    vi.advanceTimersByTime(1000 + 60_000 + 1);

    // The entry survives until it (or the sweep) is touched.
    expect(svc.pendingSize()).toBe(1);
    // Polling the expired batch evicts it and reports the unknown/empty path.
    const res = svc.mediaFor(generation_id);
    expect(res.outcome).toBe("generating_media");
    expect(res.items).toEqual([]);
    expect(svc.pendingSize()).toBe(0);
  });

  it("periodic sweep drops all expired entries even without any poll", async () => {
    const svc = makeService({ mediaDelayMs: 1000 });
    svc.startSweep();
    for (let i = 0; i < 50; i++) await gen(svc, i);
    expect(svc.pendingSize()).toBe(50);

    // Advance well past the retention window AND at least one sweep interval.
    vi.advanceTimersByTime(1000 + 60_000 + 30_000 + 1);

    expect(svc.pendingSize()).toBe(0);
    svc.stopSweep();
  });

  it("does NOT evict entries still inside their retention window", async () => {
    const svc = makeService({ mediaDelayMs: 1000 });
    const { generation_id } = await gen(svc, 0);
    for (let i = 1; i < 5; i++) await gen(svc, i);
    expect(svc.pendingSize()).toBe(5);

    // Just past readyAt but well inside the 60s retention floor.
    vi.advanceTimersByTime(2000);
    const res = svc.mediaFor(generation_id);
    // Ready content is still served (entry retained, recomputed deterministically).
    expect(["ready", "degraded"]).toContain(res.outcome);
    expect(svc.pendingSize()).toBe(5);
  });
});
