import { z } from "zod";

import { DisplayBlockSchema } from "./order.js";
import { TrackingEventSchema } from "./realtime.js";

/**
 * Tracking snapshot (doc 01 §8, doc 05 §5.1 — ADDITIVE, Milestone 3b).
 *
 * The authoritative catch-up payload `GET /v1/orders/{id}/tracking` returns: the
 * order's current state + display block, the ordered tracking-event log, and the
 * highest applied `seq`. `TrackingClient.start` (doc 05 §5.1) reads `latestSeq`
 * + replays `events` before connecting the SSE stream with `Last-Event-ID`, so a
 * client reconciles against the DB (the source of truth) on every (re)connect.
 *
 * This shape was implied by doc 05 §5.1's `TrackingClient.start` (`snap.latestSeq`,
 * `snap.events`) but had no canonical Zod schema; this adds it ADDITIVELY within
 * /v1 (new schema, nothing removed or repurposed — doc 05 §8.1).
 */
export const TrackingSnapshotSchema = z.object({
  orderId: z.string(), // ord_…
  state: z.string(), // current machine state key (opaque to the client)
  display: DisplayBlockSchema, // ordered stages marked reached/current
  events: z.array(TrackingEventSchema), // the ordered, gap-free replay log (seq ASC)
  latestSeq: z.number().int().nonnegative(), // highest applied seq (= the cursor)
});
export type TrackingSnapshot = z.infer<typeof TrackingSnapshotSchema>;
