import { Injectable } from "@nestjs/common";
import { type Order as PrismaOrder, type Prisma } from "@prisma/client";

import { ConflictError } from "../common/errors";
import { EventBus } from "../events/event-bus.service";
import { resolveTransition } from "../vertical-registry/state-machine";
import { VerticalRegistry } from "../vertical-registry/vertical-registry.service";

/** Result of an applied transition (within the caller's transaction). */
export interface TransitionResult {
  fromState: string;
  toState: string;
  seq: number; // the new per-order monotonic seq (gap-free, from tracking_events)
  label: string;
  terminal: boolean;
}

/**
 * OrderTransitionService (doc 01 §9.1) — the ONE place an order transition is
 * applied. Generic over the vertical: it asks the pinned machine whether the
 * (state, event) edge is legal, and if so writes — IN ONE TRANSACTION — the new
 * order state, the appended `tracking_events` row (whose composite PK supplies
 * the gap-free per-order `seq` — this is the M4 resolution), and the
 * `order.transition` outbox event. No `if (vertical === …)` anywhere.
 *
 * Both the API `cancel` path and the worker `advance` ticker call
 * `applyTransitionTx` with their own `tx`, so the state machine + the atomic
 * event+state write exist exactly once and behave identically (the C1 dual-write
 * lesson: the tracking event and the state change commit together or not at all).
 */
@Injectable()
export class OrderTransitionService {
  constructor(
    private readonly registry: VerticalRegistry,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * Apply `event` to `order` within the caller's transaction. Throws
   * ConflictError (→ 409) if the machine has no edge for (state, event). The
   * `seq` is derived from the persisted tracking_events log, NOT a Redis counter
   * (charter §4.3) — so it is durable and gap-free per order.
   */
  async applyTransitionTx(
    tx: Prisma.TransactionClient,
    order: Pick<PrismaOrder, "id" | "verticalId" | "state">,
    event: string,
  ): Promise<TransitionResult> {
    const vertical = this.registry.get(order.verticalId);
    const next = resolveTransition(vertical.stateMachine, order.state, event);
    if (!next) {
      throw new ConflictError(`illegal transition: ${order.state} --${event}-->`, {
        state: order.state,
        event,
      });
    }

    // Gap-free per-order seq: the next value after the current max in the
    // append-only tracking_events log. The composite PK (orderId, seq) makes a
    // concurrent duplicate insert at the same seq fail — so seq is unique +
    // monotonic without a separate counter (M4 resolved at the source of truth).
    const last = await tx.trackingEvent.aggregate({
      where: { orderId: order.id },
      _max: { seq: true },
    });
    const seq = (last._max.seq ?? -1) + 1;

    const label = vertical.tracking.labelFor(next);
    const terminal = vertical.stateMachine.states[next]?.type === "final";

    await tx.order.update({ where: { id: order.id }, data: { state: next, seq } });
    await tx.trackingEvent.create({
      data: {
        orderId: order.id,
        seq,
        type: "state_change",
        state: next,
        label,
        // Resend the full display block on the event so a fresh SSE subscriber
        // can render the timeline without an extra snapshot fetch (doc 05 §4.3).
        payload: {
          display: {
            stages: vertical.tracking.stagesFor(next),
            trackingMode: vertical.tracking.trackingMode,
          },
        },
      },
    });
    await this.eventBus.publishTx(tx, {
      type: "order.transition",
      orderId: order.id,
      seq,
      state: next,
    });

    return { fromState: order.state, toState: next, seq, label, terminal };
  }
}
