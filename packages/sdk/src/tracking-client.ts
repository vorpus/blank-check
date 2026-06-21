import { RealtimeEventSchema, type RealtimeEvent } from "@dopamine/contracts";

import { type ApiClient } from "./client.js";
import {
  type EventSourceFactory,
  type SseConnection,
  type SseMessageEvent,
} from "./event-source.js";

/**
 * The realtime tracking client (doc 05 §5.1).
 *
 * Lifecycle for an ORDER stream:
 *   1. Snapshot-first catch-up — `orders.trackingSnapshot(id)` seeds `lastApplied`
 *      and replays the ordered event log (the DB is the source of truth, §1.5).
 *   2. Connect SSE from `lastApplied` via `Last-Event-ID` (carried in the `?token=`
 *      / EventSource URL; the api replays `seq > lastApplied`).
 *   3. Every frame is validated with `RealtimeEventSchema`, applied in `seq` order,
 *      and frames with `seq <= lastApplied` are dropped (replays/dupes, §4.3).
 *   4. On SSE error → exponential backoff reconnect; once retries are exhausted →
 *      POLLING fallback (`GET /v1/orders/{id}`) — always-available (§4.3).
 *
 * GENERATION streams (`/v1/generation/{id}/stream`, the placeholder→final image
 * swap) reuse the SAME reconnect/replay core — there is no order snapshot/poll, so
 * they start at `seq = -1` with no catch-up and no poll fallback.
 *
 * `EventSource` is INJECTED (`EventSourceFactory`) so web uses the browser's and
 * mobile a polyfill in Stage 6; the reconnect/replay logic is shared and identical.
 */

export interface TrackingClientOptions {
  api: ApiClient;
  /** Injectable SSE factory. Web: the global `EventSource`; mobile: a polyfill. */
  eventSourceFactory: EventSourceFactory;
  /** API origin (for building the SSE URL), e.g. `http://localhost:8080`. */
  baseUrl: string;
  /** Bearer token getter — appended as `?token=` (EventSource can't set headers). */
  getToken: () => string | null;
  /** Tuning knobs (sensible defaults applied). */
  backoff?: Partial<BackoffOptions>;
  /** Injectable timers (tests). Default to the globals. */
  setTimeout?: (cb: () => void, ms: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
}

export interface BackoffOptions {
  /** First retry delay (ms). */
  baseMs: number;
  /** Cap on the per-retry delay (ms). */
  maxMs: number;
  /** Consecutive SSE failures before giving up on SSE and switching to polling. */
  maxRetries: number;
  /** Polling interval once in the polling-fallback state (ms). */
  pollIntervalMs: number;
}

const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 500,
  maxMs: 10_000,
  maxRetries: 5,
  pollIntervalMs: 5_000,
};

/** Which kind of stream a subscription drives — selects catch-up + fallback. */
type StreamKind = "order" | "generation";

interface Subscription {
  stop(): void;
}

/** Opaque timer handle — `object` in Node, `number` in the browser. */
type TimerHandle = object | number;

/**
 * Shared reconnect/replay engine. One instance backs one stream (order OR
 * generation). It owns the `lastApplied` cursor, validates + de-dupes frames,
 * and drives the backoff → (order only) polling-fallback state machine.
 */
class StreamSession implements Subscription {
  private lastApplied = -1;
  private attempt = 0;
  private conn: SseConnection | null = null;
  private timer: TimerHandle | null = null;
  private pollTimer: TimerHandle | null = null;
  private stopped = false;
  private readonly setT: (cb: () => void, ms: number) => TimerHandle;
  private readonly clearT: (h: TimerHandle) => void;
  private readonly backoff: BackoffOptions;

  constructor(
    private readonly kind: StreamKind,
    private readonly streamUrl: string,
    private readonly opts: TrackingClientOptions,
    private readonly onEvent: (e: RealtimeEvent) => void,
    private readonly orderId: string | null,
  ) {
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
    // Default to the global timers; both DOM (`number`) and Node (`Timeout`)
    // handles satisfy the opaque `TimerHandle` (`object | number`).
    this.setT = opts.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
    this.clearT =
      opts.clearTimeout ?? ((h) => globalThis.clearTimeout(h as never));
  }

  /** Catch up from the snapshot (order streams only), then connect SSE. */
  async start(): Promise<void> {
    if (this.kind === "order" && this.orderId) {
      const snap = await this.opts.api.orders.trackingSnapshot(this.orderId);
      // Replay the ordered log first — `dispatch` advances `lastApplied` as it
      // applies each frame and de-dupes within the log itself. THEN clamp the
      // cursor up to `latestSeq` so the SSE resume point skips any gap the log
      // didn't carry (the snapshot's `latestSeq` is the authoritative cursor).
      for (const e of snap.events) this.dispatch(e);
      if (snap.latestSeq > this.lastApplied) this.lastApplied = snap.latestSeq;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.teardownConn();
    if (this.timer !== null) this.clearT(this.timer);
    if (this.pollTimer !== null) this.clearT(this.pollTimer);
    this.timer = null;
    this.pollTimer = null;
  }

  /** Validate, order, de-dupe, apply. The one place frames enter the client. */
  private dispatch(raw: unknown): void {
    const e = RealtimeEventSchema.parse(raw); // ← Zod boundary validation (§4.3)
    if (e.seq <= this.lastApplied) return; // drop replays / duplicates
    this.lastApplied = e.seq;
    this.onEvent(e);
  }

  private buildUrl(): string {
    const url = new URL(this.streamUrl, this.opts.baseUrl);
    const token = this.opts.getToken();
    if (token) url.searchParams.set("token", token); // EventSource can't set headers
    // Resume point: the api also honors a `Last-Event-ID` header, but the URL
    // query is the only channel an EventSource constructor reliably carries; the
    // server replays `seq > lastApplied` either way.
    if (this.lastApplied >= 0)
      url.searchParams.set("lastEventId", String(this.lastApplied));
    return url.toString();
  }

  private connect(): void {
    if (this.stopped) return;
    const conn = this.opts.eventSourceFactory(this.buildUrl());
    this.conn = conn;

    const onFrame = (ev: SseMessageEvent): void => {
      this.attempt = 0; // a delivered frame resets the backoff
      let payload: unknown;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return; // ignore malformed transport frames; a bad CONTRACT throws in dispatch
      }
      this.dispatch(payload);
    };

    // Named events (the api sets `event:` to the frame `type`) AND the default
    // `message` channel — covers servers that omit the `event:` line.
    for (const type of NAMED_EVENTS) conn.addEventListener(type, onFrame);
    conn.onmessage = onFrame;
    conn.onerror = () => this.onError();
  }

  private onError(): void {
    if (this.stopped) return;
    this.teardownConn();
    this.attempt += 1;
    if (this.attempt > this.backoff.maxRetries) {
      this.startPolling(); // SSE exhausted → always-available fallback
      return;
    }
    const delay = Math.min(
      this.backoff.maxMs,
      this.backoff.baseMs * 2 ** (this.attempt - 1),
    );
    this.timer = this.setT(() => this.connect(), delay);
  }

  /**
   * Polling fallback (order streams only). Re-reads the order; `GET /v1/orders/{id}`
   * carries the authoritative `state` — we surface it as a synthetic
   * `tracking_event` so consumers see progress even with SSE down. Generation
   * streams have no poll endpoint, so they simply stop retrying.
   */
  private startPolling(): void {
    if (this.kind !== "order" || !this.orderId) return;
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        const order = await this.opts.api.orders.get(this.orderId!);
        // Re-derive a frame from the snapshot view; `dispatch` de-dupes by seq, so
        // a bumped `latestSeq` from the next /tracking call would supersede this.
        const synthetic = {
          type: "tracking_event" as const,
          seq: this.lastApplied + 1,
          ts: new Date().toISOString(),
          orderId: order.id,
          state: order.state,
          label: currentStageLabel(order),
          display: order.display,
        };
        this.dispatch(synthetic);
      } catch {
        // swallow — keep polling; the next tick retries
      }
      if (!this.stopped)
        this.pollTimer = this.setT(
          () => void tick(),
          this.backoff.pollIntervalMs,
        );
    };
    void tick();
  }

  private teardownConn(): void {
    if (this.conn) {
      this.conn.onmessage = null;
      this.conn.onerror = null;
      this.conn.close();
      this.conn = null;
    }
  }
}

/** Server `event:` names we subscribe to (the realtime union discriminants). */
const NAMED_EVENTS = [
  "tracking_event",
  "geo_position",
  "images.ready",
  "images.degraded",
  "gen.text.delta",
  "gen.text.done",
] as const;

/** Human label for the order's current stage (for the polling-fallback frame). */
function currentStageLabel(order: {
  display: { stages: { current: boolean; label: string }[] };
}): string {
  const current = order.display.stages.find((s) => s.current);
  return (
    current?.label ??
    order.display.stages[order.display.stages.length - 1]?.label ??
    ""
  );
}

export class TrackingClient {
  constructor(private readonly opts: TrackingClientOptions) {}

  /**
   * Subscribe to an order's live tracking. Snapshot-first catch-up, then SSE with
   * backoff → polling fallback. Returns a handle; call `.stop()` to unsubscribe.
   */
  trackOrder(
    orderId: string,
    onEvent: (e: RealtimeEvent) => void,
  ): Subscription {
    const session = new StreamSession(
      "order",
      `/v1/orders/${encodeURIComponent(orderId)}/stream`,
      this.opts,
      onEvent,
      orderId,
    );
    void session.start();
    return session;
  }

  /**
   * Subscribe to a generation's image-swap stream (placeholder→final). Reuses the
   * same reconnect/replay core; no order snapshot and no polling fallback.
   */
  trackGeneration(
    generationId: string,
    onEvent: (e: RealtimeEvent) => void,
  ): Subscription {
    const session = new StreamSession(
      "generation",
      `/v1/generation/${encodeURIComponent(generationId)}/stream`,
      this.opts,
      onEvent,
      null,
    );
    void session.start();
    return session;
  }
}

export type { Subscription };
