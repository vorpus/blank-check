import { type Media } from "@dopamine/contracts";

/**
 * The internal domain-event union (doc 01 §2.2). These are the events written to
 * the transactional outbox and (best-effort) emitted in-process. The PUBLIC wire
 * events live in `@dopamine/contracts` realtime.ts; the OutboxRelay maps these
 * internal events onto the public ones when it fans out over Redis pub/sub.
 *
 * Milestone 3a emits `listing.generated`, `images.ready`, `images.degraded`.
 * The order.* events are declared now (seam for 3b) but not emitted by 3a code.
 */
export type DomainEvent =
  | {
      type: "listing.generated";
      listingId: string;
      storefrontId: string;
      canonicalQuery: string;
    }
  | {
      type: "images.ready";
      generationId: string;
      listingId: string;
      media: Media;
    }
  | {
      type: "images.degraded";
      generationId: string;
      listingId: string;
      media: Media;
    }
  // ── Seams for Milestone 3b (declared, not emitted by 3a) ──────────────────
  | { type: "order.placed"; orderId: string; verticalId: string }
  | { type: "order.transition"; orderId: string; seq: number; state: string };

export type DomainEventType = DomainEvent["type"];
