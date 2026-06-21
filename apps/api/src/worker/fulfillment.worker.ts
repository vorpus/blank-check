import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { type Job, type Queue, Worker } from "bullmq";

import { StructuredLogger } from "../common/logger";
import { requestContext } from "../common/request-context";
import {
  FULFILLMENT_ADVANCE_QUEUE,
  QUEUE_NAMES,
  type FulfillmentAdvanceJob,
} from "../queue/queue.constants";
import { RedisService } from "../redis/redis.service";

import { FulfillmentService } from "./fulfillment.service";

/**
 * FulfillmentWorker (doc 01 §10.1, §11) — the BullMQ consumer for the
 * `fulfillment.advance` queue. Lives in the worker process. Each job advances the
 * order one step through the retail machine (via FulfillmentService, which reuses
 * the shared generic transition logic) and, unless terminal, enqueues the NEXT
 * delayed advance — so the ticker is self-perpetuating until delivered/cancelled.
 *
 * The next advance is scheduled AFTER the advancing transaction commits, carrying
 * the new (fromState, fromSeq) so a redelivery is an idempotent no-op. Terminal
 * states stop the ticker (no next job enqueued).
 */
@Injectable()
export class FulfillmentWorker implements OnModuleDestroy {
  private readonly logger = new StructuredLogger("fulfillment-worker");
  private worker: Worker<FulfillmentAdvanceJob> | null = null;

  constructor(
    private readonly fulfillment: FulfillmentService,
    private readonly redis: RedisService,
    @Inject(FULFILLMENT_ADVANCE_QUEUE) private readonly advanceQueue: Queue<FulfillmentAdvanceJob>,
  ) {}

  run(): void {
    if (this.worker) return;
    this.worker = new Worker<FulfillmentAdvanceJob>(
      QUEUE_NAMES.fulfillmentAdvance,
      (job: Job<FulfillmentAdvanceJob>) =>
        requestContext.run({ requestId: `advance:${job.data.orderId}:${String(job.data.fromSeq)}` }, async () => {
          const result = await this.fulfillment.advance(job.data);
          // Schedule the next tick only after the advance committed (the outbox +
          // tracking_event are durable); terminal states stop here.
          if (result.advanced && result.next) {
            await this.advanceQueue.add(
              QUEUE_NAMES.fulfillmentAdvance,
              {
                orderId: result.next.orderId,
                fromState: result.next.fromState,
                fromSeq: result.next.fromSeq,
              },
              { delay: result.next.delayMs },
            );
          }
          return result;
        }),
      { connection: this.redis.client.duplicate(), concurrency: 4 },
    );

    this.worker.on("failed", (job, err) => {
      this.logger.error(`advance job failed for ${job?.data.orderId ?? "?"}: ${err.message}`);
    });

    this.logger.log("fulfillment.advance worker running");
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
  }
}
