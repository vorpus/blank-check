import { describe, expect, it, vi } from "vitest";

import { type OrderTransitionService, type TransitionResult } from "../orders/order-transition.service";
import { type PrismaService } from "../prisma/prisma.service";
import { type PlanStep } from "../vertical-registry/vertical.types";

import { FulfillmentService } from "./fulfillment.service";

/**
 * FulfillmentService (doc 01 §10.1) — the advance ticker's transactional core.
 * Pins: it applies the plan step's event (via the shared transition service),
 * advances the cursor, schedules the next step (non-terminal) or stops (terminal),
 * and is an idempotent no-op on a redelivered (stale fromState/fromSeq) job.
 */

const PLAN: PlanStep[] = [
  { state: "packed", event: "dispatch_packing", delayMs: 2000 },
  { state: "shipped", event: "ship", delayMs: 6000 },
  { state: "out_for_delivery", event: "arrive_local", delayMs: 28000 },
  { state: "delivered", event: "deliver", delayMs: 3000, terminal: true },
];

function makeFixture(opts: {
  order: { state: string; seq: number };
  currentStep: number;
  transition: TransitionResult;
}) {
  const planUpdate = vi.fn().mockResolvedValue({});
  const tx = {
    order: { findUnique: vi.fn().mockResolvedValue({ id: "ord_1", verticalId: "retail", ...opts.order }) },
    fulfillmentPlan: {
      findUnique: vi.fn().mockResolvedValue({ orderId: "ord_1", steps: PLAN, currentStep: opts.currentStep }),
      update: planUpdate,
    },
  };
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const transitions = {
    applyTransitionTx: vi.fn().mockResolvedValue(opts.transition),
  } as unknown as OrderTransitionService;
  return { prisma, transitions, planUpdate, tx };
}

describe("FulfillmentService", () => {
  it("advances a step and schedules the next (non-terminal)", async () => {
    const f = makeFixture({
      order: { state: "confirmed", seq: 0 },
      currentStep: 0,
      transition: { fromState: "confirmed", toState: "packed", seq: 1, label: "Packed", terminal: false },
    });
    const svc = new FulfillmentService(f.prisma, f.transitions);

    const result = await svc.advance({ orderId: "ord_1", fromState: "confirmed", fromSeq: 0 });

    expect(result.advanced).toBe(true);
    expect(result.terminal).toBe(false);
    // next step is `shipped` with its delay; fromState/fromSeq carried forward.
    expect(result.next).toEqual({ orderId: "ord_1", fromState: "packed", fromSeq: 1, delayMs: 6000 });
    // cursor advanced + nextTickAt set (non-null).
    const upd = f.planUpdate.mock.calls[0]?.[0] as { data: { currentStep: number; nextTickAt: Date | null } };
    expect(upd.data.currentStep).toBe(1);
    expect(upd.data.nextTickAt).not.toBeNull();
  });

  it("stops the ticker at the terminal step (no next job, nextTickAt null)", async () => {
    const f = makeFixture({
      order: { state: "out_for_delivery", seq: 3 },
      currentStep: 3,
      transition: { fromState: "out_for_delivery", toState: "delivered", seq: 4, label: "Delivered", terminal: true },
    });
    const svc = new FulfillmentService(f.prisma, f.transitions);

    const result = await svc.advance({ orderId: "ord_1", fromState: "out_for_delivery", fromSeq: 3 });

    expect(result.terminal).toBe(true);
    expect(result.next).toBeNull();
    const upd = f.planUpdate.mock.calls[0]?.[0] as { data: { nextTickAt: Date | null } };
    expect(upd.data.nextTickAt).toBeNull();
  });

  it("is an idempotent no-op when the order moved past the job (redelivery)", async () => {
    const f = makeFixture({
      order: { state: "shipped", seq: 2 }, // already advanced past confirmed/0
      currentStep: 2,
      transition: { fromState: "x", toState: "y", seq: 0, label: "", terminal: false },
    });
    const svc = new FulfillmentService(f.prisma, f.transitions);

    const result = await svc.advance({ orderId: "ord_1", fromState: "confirmed", fromSeq: 0 });

    expect(result.advanced).toBe(false);
    expect(result.next).toBeNull();
    expect(f.transitions.applyTransitionTx).not.toHaveBeenCalled();
  });
});
