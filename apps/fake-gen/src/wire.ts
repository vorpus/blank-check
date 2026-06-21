import {
  GenerationRequestSchema,
  GenerationResultSchema,
  MediaSchema,
} from "@dopamine/contracts";
import { z } from "zod";

/**
 * fake-gen's HTTP wire shapes — thin envelopes around the canonical
 * `@dopamine/contracts` types. The contract types ARE the source of truth; this
 * file only adds the request envelope (`count`) and the `GET /media` response
 * envelope, neither of which the canonical contracts model (they live on the
 * backend↔provider hop, not the public `/v1` API).
 *
 * Validating outgoing responses against these schemas in dev/test makes contract
 * drift fail loudly (doc 05 §7): if the generator ever produces a shape the
 * contracts reject, the request 500s in dev and the test suite goes red.
 */

/**
 * `POST /generate` request. The canonical `GenerationRequest` (query, vertical,
 * deviceId, requestId, locale?) plus an optional `count` — the one documented
 * addition over the real §8.1 request (doc 02 §2.1). When `count` is present this
 * is exactly `GenerationGridRequest`.
 */
export const GenerateRequestSchema = GenerationRequestSchema.extend({
  count: z.number().int().positive().optional(),
});
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

/**
 * `POST /generate` / `POST /generate-grid` response. An envelope plus an array of
 * `GenerationResult` (one element when `count === 1`) — the same shape the real
 * multi-listing path returns, so the backend has one code path.
 */
export const GenerateResponseSchema = z.object({
  generation_id: z.string(), // batch id; correlates the swap
  origin: GenerationResultSchema.shape.origin, // always "generated" from fake-gen
  status: GenerationResultSchema.shape.status, // batch-level media status
  results: z.array(GenerationResultSchema), // each carries its own generation_id
});
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

/**
 * `GET /media/:generationId` response — the worker-driven readiness poll
 * (charter §5.5.2). The worker maps each item's `media` into an `images.ready` /
 * `images.degraded` event after ingesting the bytes. `outcome` is the batch
 * verdict; per-item `media.status` carries the same `ready`/`degraded`.
 */
export const MediaPollItemSchema = z.object({
  generation_id: z.string(), // the per-listing generation id
  client_ref: z.string(), // stable within-batch handle (g0..gN)
  media: MediaSchema, // status: ready | degraded; final or kept-placeholder
});
export type MediaPollItem = z.infer<typeof MediaPollItemSchema>;

export const MediaPollResponseSchema = z.object({
  generation_id: z.string(), // the batch id requested
  outcome: z.enum(["ready", "degraded", "generating_media"]),
  items: z.array(MediaPollItemSchema),
});
export type MediaPollResponse = z.infer<typeof MediaPollResponseSchema>;

/**
 * The COLD token-stream events (doc 02 §6.1), shaped to the canonical
 * `gen.text.delta` / `gen.text.done` realtime events minus the fields the
 * backend stamps (`seq`, `ts`, `listing_id`). fake-gen emits these on an internal
 * channel; the backend relays them onto its client SSE fan-out keyed on
 * `generation_id` and stamps `seq`/`ts`/`listing_id`.
 */
export const GenStreamStartSchema = z.object({
  type: z.literal("gen.start"),
  generation_id: z.string(),
  client_ref: z.string(),
  fields: z.array(z.string()),
});
export const GenStreamDeltaSchema = z.object({
  type: z.literal("gen.text.delta"),
  generation_id: z.string(),
  client_ref: z.string(),
  field: z.enum(["title", "description"]),
  delta: z.string(),
});
export const GenStreamFieldDoneSchema = z.object({
  type: z.literal("gen.field_done"),
  generation_id: z.string(),
  client_ref: z.string(),
  field: z.enum(["title", "description"]),
});
export const GenStreamDoneSchema = z.object({
  type: z.literal("gen.text.done"),
  generation_id: z.string(),
  client_ref: z.string(),
});
export const GenStreamEventSchema = z.discriminatedUnion("type", [
  GenStreamStartSchema,
  GenStreamDeltaSchema,
  GenStreamFieldDoneSchema,
  GenStreamDoneSchema,
]);
export type GenStreamEvent = z.infer<typeof GenStreamEventSchema>;
