import {
  type GenerationRequest,
  type GenerationResult,
  GenerationResultSchema,
  type Media,
  MediaSchema,
} from "@dopamine/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import { StructuredLogger } from "../common/logger";
import { ENV } from "../config/config.module";
import { type Env } from "../config/env";

/**
 * The fake-gen HTTP envelope shapes (charter §5.5.6). The backend integrates
 * against the AS-BUILT fake-gen contract, not doc prose. These mirror
 * apps/fake-gen/src/wire.ts. The canonical `@dopamine/contracts` types are the
 * source of truth for the inner `GenerationResult` / `Media`; only the envelopes
 * (`{ generation_id, origin, status, results }` and the `/media` poll) are added.
 */
const GenerateResponseSchema = z.object({
  generation_id: z.string(),
  origin: GenerationResultSchema.shape.origin,
  status: GenerationResultSchema.shape.status,
  results: z.array(GenerationResultSchema),
});
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

const MediaPollItemSchema = z.object({
  generation_id: z.string(),
  client_ref: z.string(),
  media: MediaSchema,
});
const MediaPollResponseSchema = z.object({
  generation_id: z.string(),
  outcome: z.enum(["ready", "degraded", "generating_media"]),
  items: z.array(MediaPollItemSchema),
});
export type MediaPollResponse = z.infer<typeof MediaPollResponseSchema>;

/**
 * FakeGenClient — the GenerationProvider HTTP adapter (charter §5.5.5/6). Maps the
 * fake-gen `/generate-grid` ENVELOPE onto the `GenerationProvider.generateGrid`
 * interface (`Promise<GenerationResult[]>`), so the gateway codes against the
 * provider contract and Stage 2 swaps the container with no gateway change.
 */
@Injectable()
export class FakeGenClient {
  private readonly logger = new StructuredLogger("fake-gen-client");
  private readonly baseUrl: string;

  constructor(@Inject(ENV) env: Env) {
    this.baseUrl = env.FAKEGEN_URL.replace(/\/$/, "");
  }

  /** POST /generate-grid → the batch envelope (generation_id + results[]). */
  async generateGrid(input: GenerationRequest & { count: number }): Promise<GenerateResponse> {
    return this.post("/generate-grid", input);
  }

  /** POST /generate → the batch envelope (count defaults on the fake-gen side). */
  async generate(input: GenerationRequest): Promise<GenerateResponse> {
    return this.post("/generate", input);
  }

  /** GET /media/:generationId → the worker-driven readiness poll (charter §5.5.2). */
  async pollMedia(generationId: string): Promise<MediaPollResponse> {
    const res = await fetch(`${this.baseUrl}/media/${encodeURIComponent(generationId)}`);
    if (!res.ok) {
      throw new Error(`fake-gen GET /media/${generationId} failed: HTTP ${String(res.status)}`);
    }
    return MediaPollResponseSchema.parse(await res.json());
  }

  private async post(path: string, body: unknown): Promise<GenerateResponse> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.logger.error(`fake-gen ${path} → HTTP ${String(res.status)}: ${text}`);
      throw new Error(`fake-gen ${path} failed: HTTP ${String(res.status)}`);
    }
    return GenerateResponseSchema.parse(await res.json());
  }
}

/** The per-result media (typed for downstream ingestion). */
export type FakeGenResultMedia = Media;
export type { GenerationResult };
