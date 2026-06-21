import { type Order } from "@dopamine/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { type Prisma } from "@prisma/client";
import { type Queue } from "bullmq";

import { CartService } from "../cart/cart.service";
import { ConflictError, NotFoundError } from "../common/errors";
import { mintId } from "../common/ids";
import { StructuredLogger } from "../common/logger";
import { ENV } from "../config/config.module";
import { type Env } from "../config/env";
import { EventBus } from "../events/event-bus.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  FULFILLMENT_ADVANCE_QUEUE,
  QUEUE_NAMES,
  type FulfillmentAdvanceJob,
} from "../queue/queue.constants";
import { VerticalRegistry } from "../vertical-registry/vertical-registry.service";
import { type PlanStep } from "../vertical-registry/vertical.types";

import { OrderTransitionService } from "./order-transition.service";
import { toContractOrder } from "./order.mapper";

const ORDER_INCLUDE = { items: true } as const;

/**
 * The scale RetailFulfillment.buildPlan emits delays for (doc 01 §10: "1h"→1s at
 * 3600). The order's plan delays are re-scaled by env.TIME_SCALE / this baseline,
 * so raising TIME_SCALE compresses the demo timeline further.
 */
const STRATEGY_BASELINE_SCALE = 3600;

/**
 * OrdersService (doc 01 §2, §9, §10) — owns `orders` / `order_items`. Place is
 * idempotent on `(userId, Idempotency-Key)`: a retry with the same key returns the
 * ORIGINAL order, never a duplicate. Checkout snapshots the active cart's items
 * into frozen order_items, builds the vertical's FulfillmentPlan, seeds the
 * initial machine state, and enqueues the first `fulfillment.advance` delayed job.
 * Cancel routes through the SAME generic transition service the worker uses — the
 * machine rejects `cancel` from non-cancellable states → 409. Zero `if (vertical)`.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new StructuredLogger("orders");

  constructor(
    private readonly prisma: PrismaService,
    private readonly cart: CartService,
    private readonly registry: VerticalRegistry,
    private readonly transitions: OrderTransitionService,
    private readonly eventBus: EventBus,
    @Inject(ENV) private readonly env: Env,
    @Inject(FULFILLMENT_ADVANCE_QUEUE) private readonly advanceQueue: Queue<FulfillmentAdvanceJob>,
  ) {}

  /**
   * Place an order from the device user's active cart. Idempotent: the unique
   * `(userId, idempotencyKey)` constraint makes a same-key retry return the
   * original order. The plan + first advance job are scheduled only on a fresh
   * place (we detect the unique-violation retry and short-circuit to the original).
   */
  async place(userId: string, storefrontId: string, idempotencyKey: string): Promise<Order> {
    // Fast path: a prior place with this key → return the original order.
    const prior = await this.prisma.order.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      include: ORDER_INCLUDE,
    });
    if (prior) {
      this.logger.log(`idempotent place replay: key=${idempotencyKey} → ${prior.id}`);
      return toContractOrder(prior, this.registry.get(prior.verticalId));
    }

    const cart = await this.prisma.cart.findFirst({
      where: { userId, storefrontId, status: "active" },
      include: { items: { include: { listing: true }, orderBy: { id: "asc" } } },
    });
    if (!cart || cart.items.length === 0) {
      throw new ConflictError("cannot place an order from an empty cart");
    }

    const storefront = await this.prisma.storefront.findUnique({ where: { id: storefrontId } });
    if (!storefront) throw new NotFoundError(`storefront not found: ${storefrontId}`);
    const vertical = this.registry.get(storefront.verticalId);
    const initialState = vertical.stateMachine.initial;
    const totalCents = cart.items.reduce((sum, it) => sum + it.unitPriceCents * it.qty, 0);
    const currency = cart.items[0]?.listing.currency ?? "USD";
    const orderId = mintId("order");

    // Build the plan, then apply the runtime TIME_SCALE so the demo can compress
    // the timeline. The strategy emits delays for a baseline scale of 3600 ("1h"→
    // 1s); we re-scale by env.TIME_SCALE / 3600 so a larger TIME_SCALE → faster.
    const baseSteps = vertical.fulfillment.buildPlan({
      id: orderId,
      verticalId: vertical.id,
      state: initialState,
    });
    const steps: PlanStep[] = baseSteps.map((s) => ({
      ...s,
      delayMs: Math.max(1, Math.round((s.delayMs * STRATEGY_BASELINE_SCALE) / this.env.TIME_SCALE)),
    }));

    let firstStep: PlanStep | undefined;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.order.create({
          data: {
            id: orderId,
            userId,
            verticalId: vertical.id,
            storefrontId,
            state: initialState,
            stateMachineKey: vertical.stateMachineKey,
            totalCents,
            currency,
            idempotencyKey,
            seq: 0,
            items: {
              create: cart.items.map((it) => ({
                id: mintId("orderItem"),
                listingId: it.listingId,
                titleSnapshot: it.listing.title, // frozen at order time (doc 01 §1.2)
                unitPriceSnapshot: it.unitPriceCents,
                qty: it.qty,
              })),
            },
          },
        });

        firstStep = steps[0];
        await tx.fulfillmentPlan.create({
          data: {
            id: mintId("fulfillmentPlan"),
            orderId,
            verticalId: vertical.id,
            steps: steps as unknown as Prisma.InputJsonValue,
            currentStep: 0,
            nextTickAt: firstStep ? new Date(Date.now() + firstStep.delayMs) : null,
          },
        });

        // Close the cart so it's no longer the active cart (a new one is created
        // lazily on the next GET /v1/cart). Same tx as the order create.
        await tx.cart.update({ where: { id: cart.id }, data: { status: "ordered" } });

        await this.eventBus.publishTx(tx, {
          type: "order.placed",
          orderId,
          verticalId: vertical.id,
        });
      });
    } catch (err) {
      // Concurrent same-key place → unique violation. Return the original order.
      if (isUniqueViolation(err)) {
        const original = await this.prisma.order.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey } },
          include: ORDER_INCLUDE,
        });
        if (original) return toContractOrder(original, this.registry.get(original.verticalId));
      }
      throw err;
    }

    // Enqueue the first advance OUTSIDE the tx (the order is committed; the job
    // carries fromState/fromSeq so a redelivery is an idempotent no-op).
    if (firstStep) {
      await this.advanceQueue.add(
        QUEUE_NAMES.fulfillmentAdvance,
        { orderId, fromState: initialState, fromSeq: 0 },
        { delay: firstStep.delayMs },
      );
    }

    this.logger.log(`placed order ${orderId} (state=${initialState}, total=${String(totalCents)}c)`);
    const created = await this.getRow(orderId);
    return toContractOrder(created, vertical);
  }

  /** Order detail (vertical-agnostic display payload). Scoped to the device user. */
  async get(userId: string, orderId: string): Promise<Order> {
    const row = await this.getRow(orderId);
    if (row.userId !== userId) throw new NotFoundError(`order not found: ${orderId}`);
    return toContractOrder(row, this.registry.get(row.verticalId));
  }

  /** List the device user's orders (most recent first). */
  async list(userId: string): Promise<Order[]> {
    const rows = await this.prisma.order.findMany({
      where: { userId },
      include: ORDER_INCLUDE,
      orderBy: { placedAt: "desc" },
    });
    return rows.map((r) => toContractOrder(r, this.registry.get(r.verticalId)));
  }

  /**
   * Cancel an order. Routes through the generic transition service: the machine
   * accepts `cancel` only from cancellable states (confirmed/packed). From
   * shipped/out_for_delivery/delivered there is no `cancel` edge → 409. The
   * tracking event + state change commit in one transaction; the OutboxRelay then
   * fans the cancellation out over SSE like any other transition.
   */
  async cancel(userId: string, orderId: string): Promise<Order> {
    const row = await this.getRow(orderId);
    if (row.userId !== userId) throw new NotFoundError(`order not found: ${orderId}`);

    await this.prisma.$transaction(async (tx) => {
      // Re-read inside the tx for a consistent (state, seq) basis.
      const fresh = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      const result = await this.transitions.applyTransitionTx(tx, fresh, "cancel");
      // Stop the ticker: a cancelled order is terminal, so null out nextTickAt.
      if (result.terminal) {
        await tx.fulfillmentPlan.updateMany({
          where: { orderId },
          data: { nextTickAt: null },
        });
      }
    });

    const updated = await this.getRow(orderId);
    return toContractOrder(updated, this.registry.get(updated.verticalId));
  }

  private async getRow(orderId: string): Promise<Awaited<ReturnType<OrdersService["fetchRow"]>>> {
    return this.fetchRow(orderId);
  }

  private async fetchRow(orderId: string) {
    const row = await this.prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
    if (!row) throw new NotFoundError(`order not found: ${orderId}`);
    return row;
  }
}

/** Prisma P2002 = unique constraint violation (the idempotency-key race). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}
