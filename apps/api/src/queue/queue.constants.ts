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

/** DI token for the fulfillment.advance BullMQ Queue (Milestone 3b). */
export const FULFILLMENT_ADVANCE_QUEUE = Symbol("FULFILLMENT_ADVANCE_QUEUE");

/**
 * The payload the orders module enqueues and the fulfillment ticker consumes
 * (doc 01 §10.1). `fromState`/`fromSeq` make a redelivered advance an idempotent
 * no-op: if the order has already moved past this point, the processor skips —
 * so at-least-once BullMQ delivery never double-advances an order.
 */
export interface FulfillmentAdvanceJob {
  orderId: string;
  fromState: string;
  fromSeq: number;
}

/** The payload the gateway enqueues and the worker processor consumes. */
export interface GenerationEnrichJob {
  /** generation_jobs.id — links the job back to its persisted record. */
  jobId: string;
  /**
   * The originating request's id, propagated across the api→worker boundary so the
   * worker's logs/events correlate with the search that triggered them (instead of
   * an opaque `enrich:<genId>`).
   */
  requestId: string;
  /** fake-gen batch generation id — what the worker polls `GET /media/:id` with. */
  generationId: string;
  storefrontId: string;
  verticalId: string;
  canonicalQuery: string;
  /** The listing ids minted during the synchronous write-back, in batch order. */
  listingIds: string[];
}
