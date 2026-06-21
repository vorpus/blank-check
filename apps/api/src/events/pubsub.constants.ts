/**
 * Redis pub/sub channel names (doc 01 §2.2, §10). The OutboxRelay publishes onto
 * these; the 3b SSE gateway subscribes. Centralized so producer and consumer
 * never drift on a channel string.
 */

/**
 * The generation fan-out channel (charter §5.5.2). `images.ready` / `images.degraded`
 * ride this; the 3b SSE gateway relays them onto the client stream keyed on
 * generation_id. Named `order/generation` because in 3b the same fan-out also
 * carries order tracking — generation swaps and order events share one transport.
 */
export const GENERATION_CHANNEL = "order/generation";

/** Per-order tracking channel (seam for 3b). */
export const orderChannel = (orderId: string): string => `order:${orderId}`;
