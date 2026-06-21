import { Injectable } from "@nestjs/common";

import { StructuredLogger } from "../common/logger";
import { OrderTransitionService } from "../orders/order-transition.service";
import { PrismaService } from "../prisma/prisma.service";
import { type FulfillmentAdvanceJob } from "../queue/queue.constants";
import { type PlanStep } from "../vertical-registry/vertical.types";

/** The advance outcome the processor uses to schedule (or not) the next tick. */
export interface AdvanceResult {
  advanced: boolean;
  terminal: boolean;
  /** Args for the next advance job (null when terminal or no-op). */
  next: { orderId: string; fromState: string; fromSeq: number; delayMs: number } | null;
}

/**
 * FulfillmentService (doc 01 §10.1) — the fulfillment ticker's transactional core.
 * One `advance` does, in ONE transaction:
 *   - guard idempotency: if the order has already moved past (fromState, fromSeq)
 *     this is a redelivery → no-op (BullMQ is at-least-once).
 *   - apply the plan's current step's event via the SHARED generic transition
 *     service (validates the machine edge, bumps state, appends a gap-free
 *     tracking_event, writes the order.transition outbox event — all atomically).
 *   - advance the plan cursor + set nextTickAt (null at a terminal step).
 * The processor then schedules the NEXT advance with the next step's delay. The
 * transition logic + the atomic event+state write are reused verbatim from the
 * API cancel path — no duplicated state-machine code across api and worker.
 */
@Injectable()
export class FulfillmentService {
  private readonly logger = new StructuredLogger("fulfillment");

  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: OrderTransitionService,
  ) {}

  async advance(job: FulfillmentAdvanceJob): Promise<AdvanceResult> {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: job.orderId } });
      if (!order) {
        this.logger.warn(`advance for missing order ${job.orderId}; skipping`);
        return noop();
      }
      // Idempotent no-op on redelivery: the order already moved past this point.
      if (order.state !== job.fromState || order.seq !== job.fromSeq) {
        this.logger.log(
          `advance no-op for ${job.orderId} (have ${order.state}/${String(order.seq)}, job ${job.fromState}/${String(job.fromSeq)})`,
        );
        return noop();
      }

      const plan = await tx.fulfillmentPlan.findUnique({ where: { orderId: order.id } });
      if (!plan) {
        this.logger.warn(`advance for order ${job.orderId} with no plan; skipping`);
        return noop();
      }
      const steps = plan.steps as unknown as PlanStep[];
      const step = steps[plan.currentStep];
      if (!step) return noop(); // plan exhausted (shouldn't happen before terminal)

      // Apply the step's event through the shared, generic transition service.
      const result = await this.transitions.applyTransitionTx(tx, order, step.event);

      const nextStep = steps[plan.currentStep + 1];
      const terminal = result.terminal || !nextStep;
      await tx.fulfillmentPlan.update({
        where: { orderId: order.id },
        data: {
          currentStep: plan.currentStep + 1,
          nextTickAt: terminal ? null : new Date(Date.now() + (nextStep?.delayMs ?? 0)),
        },
      });

      this.logger.log(
        `advanced ${order.id}: ${result.fromState} → ${result.toState} (seq ${String(result.seq)})${terminal ? " [terminal]" : ""}`,
      );

      return {
        advanced: true,
        terminal,
        next:
          terminal || !nextStep
            ? null
            : {
                orderId: order.id,
                fromState: result.toState,
                fromSeq: result.seq,
                delayMs: nextStep.delayMs,
              },
      };
    });
  }
}

function noop(): AdvanceResult {
  return { advanced: false, terminal: false, next: null };
}
