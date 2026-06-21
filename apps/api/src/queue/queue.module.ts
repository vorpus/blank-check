import { Global, Module, type Provider } from "@nestjs/common";
import { Queue } from "bullmq";

import { RedisService } from "../redis/redis.service";

import { GENERATION_ENRICH_QUEUE, QUEUE_NAMES } from "./queue.constants";

/**
 * BullMQ module (charter §3). Provides the producer-side `Queue` instances so the
 * generation gateway can `queue.add('generation.enrich', …)`. The worker process
 * creates its own `Worker` (consumer) for the same queue name — see
 * worker/generation.worker.ts. DLQ/retries are configured at enqueue time
 * (attempts + backoff) and surfaced via BullMQ's failed-job set.
 */
const generationEnrichQueueProvider: Provider = {
  provide: GENERATION_ENRICH_QUEUE,
  useFactory: (redis: RedisService): Queue =>
    new Queue(QUEUE_NAMES.generationEnrich, {
      // BullMQ needs its own connection (a duplicate of the shared one with the
      // null retry policy BullMQ requires).
      connection: redis.client.duplicate(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 500 },
        removeOnComplete: 1000,
        removeOnFail: 5000, // keep failed jobs as the DLQ surface
      },
    }),
  inject: [RedisService],
};

@Global()
@Module({
  providers: [generationEnrichQueueProvider],
  exports: [GENERATION_ENRICH_QUEUE],
})
export class QueueModule {}
