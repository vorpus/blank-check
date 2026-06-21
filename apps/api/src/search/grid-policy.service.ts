import { Inject, Injectable } from "@nestjs/common";

import { ENV } from "../config/config.module";
import { type Env } from "../config/env";

export type Regime = "hot" | "warm" | "cold";

export interface GridPlan {
  regime: Regime;
  /** How many cards to pull from cache/FTS now. */
  fromCache: number;
  /** How many cards to ask the generator for. */
  generate: number;
}

const HOT_POP = 25; // popularity at/above which we treat a query as hot
const COLD_FILLER = 6; // loose trgm filler cards shown instantly on a cold miss

/**
 * GridPolicyService (doc 01 §5) — the SIMPLIFIED blended grid policy (no
 * embeddings). Classifies a query into hot/warm/cold from FTS `matchCount` + a
 * Redis `popularity` counter only (the `s_max` pgvector regime input is dropped
 * until Stage 2). Decides how many cards come from cache vs. generation so search
 * always returns a populated grid (target GRID_TARGET) and never blocks.
 */
@Injectable()
export class GridPolicyService {
  private readonly gridTarget: number;
  private readonly coldBatch: number;

  constructor(@Inject(ENV) env: Env) {
    this.gridTarget = env.GRID_TARGET;
    this.coldBatch = env.COLD_BATCH;
  }

  classify(matchCount: number, popularity: number): GridPlan {
    if (matchCount >= this.gridTarget || popularity >= HOT_POP) {
      // 🔥 hot — full grid from cache, nothing generated.
      return { regime: "hot", fromCache: this.gridTarget, generate: 0 };
    }
    if (matchCount >= 1) {
      // 🌤 warm — show the matches now, generate the rest as one batch.
      return { regime: "warm", fromCache: matchCount, generate: this.gridTarget - matchCount };
    }
    // ❄️ cold — a few loose trgm filler cards + a generated batch.
    return { regime: "cold", fromCache: COLD_FILLER, generate: this.coldBatch };
  }
}
