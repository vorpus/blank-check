import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { type Job, Worker } from "bullmq";

import { StructuredLogger } from "../common/logger";
import { requestContext } from "../common/request-context";
import { EnrichService, MediaNotReadyError } from "../generation/enrich.service";
import { QUEUE_NAMES, type GenerationEnrichJob } from "../queue/queue.constants";
import { RedisService } from "../redis/redis.service";

/**
 * GenerationWorker (doc 01 §11) — registers the BullMQ consumer for the
 * `generation.enrich` queue and delegates each job to EnrichService. Lives in the
 * worker process only (the api enqueues; the worker consumes). Retries/backoff +
 * the failed-job set (DLQ) come from the queue's defaultJobOptions; a
 * `MediaNotReadyError` is a soft retry (poll again), other errors burn an attempt.
 */
@Injectable()
export class GenerationWorker implements OnModuleDestroy {
  private readonly logger = new StructuredLogger("generation-worker");
  private worker: Worker<GenerationEnrichJob> | null = null;

  constructor(
    private readonly enrich: EnrichService,
    private readonly redis: RedisService,
  ) {}

  run(): void {
    if (this.worker) return;
    this.worker = new Worker<GenerationEnrichJob>(
      QUEUE_NAMES.generationEnrich,
      (job: Job<GenerationEnrichJob>) =>
        // Seed the worker's request context from the propagated requestId so its
        // logs/events correlate with the originating search (fall back to a
        // generation-scoped id for older jobs enqueued before requestId existed).
        requestContext.run({ requestId: job.data.requestId ?? `enrich:${job.data.generationId}` }, async () => {
          const result = await this.enrich.enrich(job.data);
          return result;
        }),
      { connection: this.redis.client.duplicate(), concurrency: 4 },
    );

    this.worker.on("failed", (job, err) => {
      if (err instanceof MediaNotReadyError) {
        this.logger.log(`enrich retry (media not ready): ${job?.data.generationId ?? "?"}`);
      } else {
        this.logger.error(`enrich job failed: ${err.message}`);
      }
    });
    this.worker.on("completed", (job) => {
      this.logger.log(`enrich completed: ${job.data.generationId}`);
    });

    this.logger.log("generation.enrich worker running");
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
  }
}
