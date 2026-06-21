import { EventEmitter } from "node:events";

import { Injectable } from "@nestjs/common";
import { type Prisma } from "@prisma/client";

import { mintId } from "../common/ids";

import { type DomainEvent } from "./domain-events";

/**
 * EventBus (doc 01 §2.2) — the transactional outbox writer + in-process fast path.
 *
 * `publishTx` MUST be called with the SAME Prisma transaction client as the state
 * change it accompanies: the outbox row commits atomically with the state, which
 * is what solves the dual-write problem (you can never commit the state but lose
 * the event, or vice versa). The OutboxRelay later drains pending rows to Redis
 * pub/sub + BullMQ and marks them published — at-least-once delivery, consumers
 * dedupe via the inbox table.
 *
 * `emitLocal` is a best-effort in-process notification for cheap reactions (e.g.
 * cache warming); it is NEVER the source of truth.
 */
@Injectable()
export class EventBus {
  private readonly emitter = new EventEmitter();

  /** Outbox write — atomic with the state change. */
  async publishTx(tx: Prisma.TransactionClient, event: DomainEvent): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        id: mintId("outboxEvent"),
        type: event.type,
        payload: event,
        status: "pending",
      },
    });
  }

  /** In-process fast path (best-effort; not durable). */
  emitLocal(event: DomainEvent): void {
    this.emitter.emit(event.type, event);
  }

  onLocal(type: DomainEvent["type"], handler: (event: DomainEvent) => void): void {
    this.emitter.on(type, handler);
  }
}
