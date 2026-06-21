import {
  type GenerationResult,
  type Media,
  GenerationResultSchema,
  MediaSchema,
} from "@dopamine/contracts";

import { type FakeGenConfig } from "./config.js";
import { buildBatch, type BuildOptions, finalMedia } from "./generator.js";
import { digestHex, rng, seed } from "./seed.js";
import {
  type GenerateRequest,
  type GenerateResponse,
  type GenStreamEvent,
  type MediaPollResponse,
  GenerateResponseSchema,
  MediaPollResponseSchema,
} from "./wire.js";

/**
 * The generation service — orchestrates the pure generator (`generator.ts`) and
 * the small in-memory enrichment schedule, applies the configurable
 * latency/failure knobs, and validates every outgoing payload against
 * `@dopamine/contracts` so drift fails loudly (doc 05 §7).
 *
 * State: fake-gen is stateless for *content* (everything re-derives from the
 * query — doc 02 §3), but holds a tiny in-memory schedule of pending enrichments
 * (`generation_id → { query, vertical, count, readyAt }`) so it can answer
 * `GET /media/:generationId`. Losing it on restart is harmless: the worst case is
 * the backend falling back to the placeholder / `degraded` (doc 02 §2).
 */

interface PendingEnrichment {
  query: string;
  vertical: string;
  count: number;
  readyAt: number; // epoch ms when final media becomes available
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/** Slice a string into groups of `n` whitespace-delimited words. */
function chunkWords(s: string, n: number): string[] {
  const words = s.split(/(\s+)/).filter((w) => w.trim().length > 0);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += n) {
    out.push(words.slice(i, i + n).join(" ") + (i + n < words.length ? " " : ""));
  }
  return out;
}

export class GenerationService {
  private readonly pending = new Map<string, PendingEnrichment>();

  constructor(private readonly cfg: FakeGenConfig) {}

  /**
   * Mint a deterministic batch `generation_id`. Deterministic so the same
   * `(requestId, query, vertical)` reproduces the same id — keeping the demo /
   * tests reproducible — but still `gen_`-prefixed and ULID-shaped enough for the
   * backend to thread through (the backend treats it as opaque).
   */
  private mintGenerationId(req: GenerateRequest): string {
    const body = digestHex(`${req.requestId}|${req.vertical}|${req.query}`).toUpperCase();
    // 26-char Crockford-ish body from the hex digest (kept deterministic + opaque).
    const ulid = body.replace(/[^0-9A-HJKMNP-TV-Z]/g, "0").padEnd(26, "0").slice(0, 26);
    return `gen_${ulid}`;
  }

  /** Per-listing generation id within a batch — `<batchId>:g<variant>`. */
  private listingGenerationId(batchId: string, variant: number): string {
    return `${batchId}:g${String(variant)}`;
  }

  private buildOptions(): BuildOptions {
    const inline = this.cfg.mediaMode === "inline";
    return {
      publicBaseUrl: this.cfg.publicBaseUrl,
      expectedReadyMs: this.cfg.mediaDelayMs,
      status: inline ? "ready" : "generating_media",
    };
  }

  /** Clamp the requested `count` to `[1, gridMax]`, defaulting when omitted. */
  private resolveCount(req: GenerateRequest): number {
    const requested = req.count ?? this.cfg.defaultCount;
    return Math.min(this.cfg.gridMax, Math.max(1, requested));
  }

  /**
   * The fast path. Returns the batch envelope + each variant's `GenerationResult`
   * (placeholder media, `generating_media`) and schedules the enrichment so a
   * later `GET /media/:generationId` resolves. Honors `FAKE_TEXT_DELAY_MS`.
   *
   * Throws `GenerateFailedError` when `FAKE_FAIL_GENERATE=1` so the route can emit
   * the `generation_failed` error envelope (doc 02 §2.3).
   */
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    if (this.cfg.failGenerate) {
      throw new GenerateFailedError();
    }
    await sleep(this.cfg.textDelayMs);

    const batchId = this.mintGenerationId(req);
    const count = this.resolveCount(req);
    const opts = this.buildOptions();

    const results = buildBatch(
      { query: req.query, vertical: req.vertical, count },
      (variant) => this.listingGenerationId(batchId, variant),
      opts,
    );

    // Schedule the enrichment unless we already returned final media inline.
    if (this.cfg.mediaMode !== "inline") {
      this.pending.set(batchId, {
        query: req.query,
        vertical: req.vertical,
        count,
        readyAt: Date.now() + this.cfg.mediaDelayMs,
      });
    }

    const response: GenerateResponse = {
      generation_id: batchId,
      origin: "generated",
      status: opts.status,
      results: this.validateResults(results),
    };
    // Validate the full envelope (drift gate).
    return GenerateResponseSchema.parse(response);
  }

  /**
   * The worker-driven readiness poll (charter §5.5.2). Re-derives the final media
   * deterministically. Before `readyAt` (or when the batch is unknown after a
   * restart but still in its delay window) it reports `generating_media`; after,
   * `ready` or `degraded` per the deterministic failure decision.
   */
  mediaFor(batchId: string): MediaPollResponse {
    const pending = this.pending.get(batchId);
    const now = Date.now();

    // Unknown batch (e.g. after restart). We can still re-derive content but not
    // the original count/query — so report not-ready; the worker retries/falls
    // back to the placeholder. We surface an empty `generating_media` envelope.
    if (!pending) {
      return MediaPollResponseSchema.parse({
        generation_id: batchId,
        outcome: "generating_media",
        items: [],
      });
    }

    if (now < pending.readyAt) {
      // Still enriching — return per-item placeholder media so the worker can poll again.
      const items = this.itemsFor(batchId, pending, "generating_media");
      return MediaPollResponseSchema.parse({
        generation_id: batchId,
        outcome: "generating_media",
        items,
      });
    }

    const degraded = this.isDegraded(batchId);
    const outcome = degraded ? "degraded" : "ready";
    const items = this.itemsFor(batchId, pending, outcome);
    return MediaPollResponseSchema.parse({
      generation_id: batchId,
      outcome,
      items,
    });
  }

  private itemsFor(
    batchId: string,
    pending: PendingEnrichment,
    outcome: "ready" | "degraded" | "generating_media",
  ): MediaPollResponse["items"] {
    const items: MediaPollResponse["items"] = [];
    for (let variant = 0; variant < pending.count; variant++) {
      const genId = this.listingGenerationId(batchId, variant);
      let media: Media;
      if (outcome === "generating_media") {
        media = {
          status: "generating_media",
          hero: finalMedia(pending.query, variant, genId, this.cfg.publicBaseUrl, "degraded").hero,
          alternates: [],
          expected_ready_ms: Math.max(0, pending.readyAt - Date.now()),
          generation_id: genId,
        };
      } else {
        media = finalMedia(pending.query, variant, genId, this.cfg.publicBaseUrl, outcome);
      }
      items.push({
        generation_id: genId,
        client_ref: `g${String(variant)}`,
        media: MediaSchema.parse(media),
      });
    }
    return items;
  }

  /**
   * Deterministic failure decision (doc 02 §7): the same batch reproducibly
   * degrades (or not), seeded by the batch id — NOT `Math.random()`.
   */
  private isDegraded(batchId: string): boolean {
    if (this.cfg.failureRate <= 0) return false;
    if (this.cfg.failureRate >= 1) return true;
    return rng(seed(batchId, "failure", 0))() < this.cfg.failureRate;
  }

  /** Validate every result against the canonical schema — drift gate (doc 05 §7). */
  private validateResults(results: GenerationResult[]): GenerationResult[] {
    return results.map((r) => GenerationResultSchema.parse(r));
  }

  /**
   * The COLD token stream (doc 02 §6.1). Yields `gen.start` → field-by-field
   * `gen.text.delta` → `gen.field_done` → `gen.text.done` for the first variant,
   * sliced from the already-deterministic text. The backend relays these onto its
   * client SSE channel and stamps `seq`/`ts`/`listing_id`.
   */
  async *streamText(req: GenerateRequest): AsyncGenerator<GenStreamEvent> {
    const batchId = this.mintGenerationId(req);
    const variant = 0;
    const clientRef = `g${String(variant)}`;
    const genId = this.listingGenerationId(batchId, variant);
    const [result] = buildBatch(
      { query: req.query, vertical: req.vertical, count: 1 },
      () => genId,
      this.buildOptions(),
    );
    if (!result) return;

    yield {
      type: "gen.start",
      generation_id: genId,
      client_ref: clientRef,
      fields: ["title", "description"],
    };
    for (const field of ["title", "description"] as const) {
      const text = field === "title" ? result.listing.title : result.listing.description;
      for (const chunk of chunkWords(text, 3)) {
        await sleep(this.cfg.streamDeltaMs);
        yield { type: "gen.text.delta", generation_id: genId, client_ref: clientRef, field, delta: chunk };
      }
      yield { type: "gen.field_done", generation_id: genId, client_ref: clientRef, field };
    }
    yield { type: "gen.text.done", generation_id: genId, client_ref: clientRef };
  }
}

/** Thrown when `FAKE_FAIL_GENERATE=1` — the route maps it to `generation_failed`. */
export class GenerateFailedError extends Error {
  constructor() {
    super("fake-gen forced generation failure (FAKE_FAIL_GENERATE=1)");
    this.name = "GenerateFailedError";
  }
}
