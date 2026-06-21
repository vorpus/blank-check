import { describe, expect, it } from "vitest";

import { type Env } from "../config/env";

import { GridPolicyService } from "./grid-policy.service";

/**
 * The simplified blended grid policy (doc 01 §5) — hot/warm/cold regime selection
 * from FTS matchCount + Redis popularity only (no embeddings). These tests pin the
 * regime boundaries the demo relies on (seeded term → hot/no-generate; novel term
 * → cold/generate-a-batch).
 */
const env = { GRID_TARGET: 24, COLD_BATCH: 8 } as Env;

describe("GridPolicyService", () => {
  const policy = new GridPolicyService(env);

  it("hot: matchCount >= GRID_TARGET → full grid from cache, nothing generated", () => {
    expect(policy.classify(24, 0)).toEqual({ regime: "hot", fromCache: 24, generate: 0 });
    expect(policy.classify(40, 0).generate).toBe(0);
  });

  it("hot: high popularity also forces hot even with few matches", () => {
    const plan = policy.classify(3, 100);
    expect(plan.regime).toBe("hot");
    expect(plan.generate).toBe(0);
  });

  it("warm: 1 <= matchCount < GRID_TARGET → show matches, generate the remainder", () => {
    const plan = policy.classify(10, 0);
    expect(plan.regime).toBe("warm");
    expect(plan.fromCache).toBe(10);
    expect(plan.generate).toBe(14); // 24 - 10
  });

  it("cold: matchCount == 0 → filler + a generated batch", () => {
    const plan = policy.classify(0, 0);
    expect(plan.regime).toBe("cold");
    expect(plan.generate).toBe(8); // COLD_BATCH
    expect(plan.fromCache).toBeGreaterThan(0);
  });
});
