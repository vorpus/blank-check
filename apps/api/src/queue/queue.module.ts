import { Global, Module, type OnModuleDestroy, type Provider } from "@nestjs/common";
import { Queue } from "bullmq";

import { RedisService } from "../redis/redis.service";

import { FULFILLMENT_ADVANCE_QUEUE, GENERATION_ENRICH_QUEUE, QUEUE_NAMES } from "./queue.constants";

/**
 * Owns the producer-side BullMQ `Queue` so its connection is closed on shutdown.
 * Registering the Queue via this class (rather than a bare factory) gives Nest an
 * `onModuleDestroy` hook to call `queue.close()` — mirroring the worker's clean
 * shutdown so a SIGTERM doesn't leak the Queue's Redis connection.
 */
class GenerationEnrichQueueProvider implements OnModuleDestroy {
  readonly queue: Queue;

  constructor(redis: RedisService) {
    this.queue = new Queue(QUEUE_NAMES.generationEnrich, {
      // BullMQ needs its own connection (a duplicate of the shared one with the
      // null retry policy BullMQ requires).
      connection: redis.client.duplicate(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 500 },
        removeOnComplete: 1000,
        removeOnFail: 5000, // keep failed jobs as the DLQ surface
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * The fulfillment.advance producer-side Queue (Milestone 3b). Delayed jobs drive
 * the order through the retail timeline; each advance schedules the next. Same
 * lifecycle-owning pattern as the generation queue so a SIGTERM closes its Redis
 * connection cleanly.
 */
class FulfillmentAdvanceQueueProvider implements OnModuleDestroy {
  readonly queue: Queue;

  constructor(redis: RedisService) {
    this.queue = new Queue(QUEUE_NAMES.fulfillmentAdvance, {
      connection: redis.client.duplicate(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 500 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * BullMQ module (charter §3). Provides the producer-side `Queue` instances so the
 * generation gateway can `queue.add('generation.enrich', …)`. The worker process
 * creates its own `Worker` (consumer) for the same queue name — see
 * worker/generation.worker.ts. DLQ/retries are configured at enqueue time
 * (attempts + backoff) and surfaced via BullMQ's failed-job set.
 */
const queueProvider: Provider = {
  provide: GenerationEnrichQueueProvider,
  useFactory: (redis: RedisService): GenerationEnrichQueueProvider =>
    new GenerationEnrichQueueProvider(redis),
  inject: [RedisService],
};

// The injection token still resolves to the raw `Queue` (so consumers inject
// `Queue<GenerationEnrichJob>` unchanged); the owning provider above holds the
// lifecycle hook that closes it.
const generationEnrichQueueProvider: Provider = {
  provide: GENERATION_ENRICH_QUEUE,
  useFactory: (owner: GenerationEnrichQueueProvider): Queue => owner.queue,
  inject: [GenerationEnrichQueueProvider],
};

const fulfillmentAdvanceOwnerProvider: Provider = {
  provide: FulfillmentAdvanceQueueProvider,
  useFactory: (redis: RedisService): FulfillmentAdvanceQueueProvider =>
    new FulfillmentAdvanceQueueProvider(redis),
  inject: [RedisService],
};

const fulfillmentAdvanceQueueProvider: Provider = {
  provide: FULFILLMENT_ADVANCE_QUEUE,
  useFactory: (owner: FulfillmentAdvanceQueueProvider): Queue => owner.queue,
  inject: [FulfillmentAdvanceQueueProvider],
};

@Global()
@Module({
  providers: [
    queueProvider,
    generationEnrichQueueProvider,
    fulfillmentAdvanceOwnerProvider,
    fulfillmentAdvanceQueueProvider,
  ],
  exports: [GENERATION_ENRICH_QUEUE, FULFILLMENT_ADVANCE_QUEUE],
})
export class QueueModule {}
