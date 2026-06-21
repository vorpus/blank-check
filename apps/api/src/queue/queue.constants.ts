/**
 * BullMQ queue + job names (doc 01 §11). Centralized so producer (api) and
 * consumer (worker) reference one source of truth and never drift on a string.
 */
export const QUEUE_NAMES = {
  /** Async image-ready progression for generated listings (Milestone 3a). */
  generationEnrich: "generation.enrich",
  /** Fulfillment ticker (Milestone 3b — queue declared now, processor lands in 3b). */
  fulfillmentAdvance: "fulfillment.advance",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** DI token for the generation.enrich BullMQ Queue. */
export const GENERATION_ENRICH_QUEUE = Symbol("GENERATION_ENRICH_QUEUE");

/** The payload the gateway enqueues and the worker processor consumes. */
export interface GenerationEnrichJob {
  /** generation_jobs.id — links the job back to its persisted record. */
  jobId: string;
  /** fake-gen batch generation id — what the worker polls `GET /media/:id` with. */
  generationId: string;
  storefrontId: string;
  verticalId: string;
  canonicalQuery: string;
  /** The listing ids minted during the synchronous write-back, in batch order. */
  listingIds: string[];
}
