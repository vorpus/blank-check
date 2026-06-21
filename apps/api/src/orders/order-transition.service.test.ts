import { describe, expect, it, vi } from "vitest";

import { ConflictError } from "../common/errors";
import { type EventBus } from "../events/event-bus.service";
import { RetailVertical } from "../vertical-registry/retail.vertical";
import { VerticalRegistry } from "../vertical-registry/vertical-registry.service";

import { OrderTransitionService } from "./order-transition.service";

/**
 * OrderTransitionService (doc 01 §9.1) — the generic, vertical-agnostic transition
 * engine reused by both the API cancel path and the worker advance ticker. Pins:
 *   1. a legal transition bumps state, derives a gap-free seq from tracking_events,
 *      appends the event + outbox row in the caller's tx.
 *   2. an illegal transition (cancel from `shipped`) throws ConflictError → 409.
 */

function makeFixture(maxSeq: number | null) {
  const tx = {
    trackingEvent: {
      aggregate: vi.fn().mockResolvedValue({ _max: { seq: maxSeq } }),
      create: vi.fn().mockResolvedValue({}),
    },
    order: { update: vi.fn().mockResolvedValue({}) },
  };
  const eventBus = { publishTx: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;
  const registry = new VerticalRegistry([new RetailVertical()]);
  const svc = new OrderTransitionService(registry, eventBus);
  return { svc, tx, eventBus };
}

describe("OrderTransitionService", () => {
  it("applies a legal transition: bumps state, gap-free seq, appends event + outbox", async () => {
    const f = makeFixture(2); // last seq was 2 → next is 3
    const order = { id: "ord_1", verticalId: "retail", state: "confirmed" };

    const result = await f.svc.applyTransitionTx(f.tx as never, order, "dispatch_packing");

    expect(result.toState).toBe("packed");
    expect(result.seq).toBe(3);
    expect(result.terminal).toBe(false);
    expect(f.tx.order.update).toHaveBeenCalledWith({
      where: { id: "ord_1" },
      data: { state: "packed", seq: 3 },
    });
    const created = f.tx.trackingEvent.create.mock.calls[0]?.[0] as { data: { seq: number; state: string } };
    expect(created.data.seq).toBe(3);
    expect(created.data.state).toBe("packed");
    expect(f.eventBus.publishTx).toHaveBeenCalledOnce();
  });

  it("derives seq 0 for the first transition (empty log)", async () => {
    const f = makeFixture(null);
    const order = { id: "ord_1", verticalId: "retail", state: "confirmed" };
    const result = await f.svc.applyTransitionTx(f.tx as never, order, "dispatch_packing");
    expect(result.seq).toBe(0);
  });

  it("marks the terminal step (deliver → delivered)", async () => {
    const f = makeFixture(3);
    const order = { id: "ord_1", verticalId: "retail", state: "out_for_delivery" };
    const result = await f.svc.applyTransitionTx(f.tx as never, order, "deliver");
    expect(result.toState).toBe("delivered");
    expect(result.terminal).toBe(true);
  });

  it("throws ConflictError (→409) for an illegal transition: cancel from shipped", async () => {
    const f = makeFixture(3);
    const order = { id: "ord_1", verticalId: "retail", state: "shipped" };
    await expect(f.svc.applyTransitionTx(f.tx as never, order, "cancel")).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(f.tx.order.update).not.toHaveBeenCalled();
  });

  it("allows cancel from a cancellable state (confirmed → cancelled, terminal)", async () => {
    const f = makeFixture(0);
    const order = { id: "ord_1", verticalId: "retail", state: "confirmed" };
    const result = await f.svc.applyTransitionTx(f.tx as never, order, "cancel");
    expect(result.toState).toBe("cancelled");
    expect(result.terminal).toBe(true);
  });
});
