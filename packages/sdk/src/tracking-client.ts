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

/**
 * Actual transport state of a subscription — the SDK is the source of truth for
 * the connection badge (no UI-side cadence heuristics).
 *   - `connecting`: opening SSE / awaiting the first frame after a (re)connect.
 *   - `live`: SSE is delivering frames.
 *   - `polling`: SSE retries exhausted; on the always-available poll fallback.
 */
export type TransportMode = "live" | "polling" | "connecting";

interface Subscription {
  stop(): void;
  /** The current transport mode (real, not inferred from event cadence). */
  getMode(): TransportMode;
  /** Subscribe to mode transitions; returns an unsubscribe. Fires on change only. */
  onModeChange(cb: (mode: TransportMode) => void): () => void;
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
  private mode: TransportMode = "connecting";
  private readonly modeListeners = new Set<(mode: TransportMode) => void>();
  /**
   * Synthetic-poll cursor (M1). Polling fabricates `tracking_event`s with no real
   * server `seq`; we count them here so each tick advances WITHOUT touching the
   * SSE `lastApplied` cursor — otherwise an invented seq becomes the resume point
   * and a real frame at that seq would be dropped on SSE recovery.
   */
  private pollSeq = 0;
  /** True once we've fallen back to polling; gates the SSE re-snapshot on recovery. */
  private polling = false;
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
    await this.catchUp();
    this.connect();
  }

  /**
   * Snapshot-first catch-up (order streams only). Replays the ordered log and
   * clamps `lastApplied` up to the snapshot's authoritative `latestSeq`. Run on
   * initial start AND on SSE recovery after a polling stint (M1) so the resume
   * cursor is always a REAL server seq, never a synthetic poll value.
   */
  private async catchUp(): Promise<void> {
    if (this.kind !== "order" || !this.orderId) return;
    const snap = await this.opts.api.orders.trackingSnapshot(this.orderId);
    // Replay the ordered log first — `dispatch` advances `lastApplied` as it
    // applies each frame and de-dupes within the log itself. THEN clamp the
    // cursor up to `latestSeq` so the SSE resume point skips any gap the log
    // didn't carry (the snapshot's `latestSeq` is the authoritative cursor).
    for (const e of snap.events) this.dispatch(e);
    if (snap.latestSeq > this.lastApplied) this.lastApplied = snap.latestSeq;
  }

  stop(): void {
    this.stopped = true;
    this.teardownConn();
    if (this.timer !== null) this.clearT(this.timer);
    if (this.pollTimer !== null) this.clearT(this.pollTimer);
    this.timer = null;
    this.pollTimer = null;
    this.modeListeners.clear();
  }

  getMode(): TransportMode {
    return this.mode;
  }

  onModeChange(cb: (mode: TransportMode) => void): () => void {
    this.modeListeners.add(cb);
    return () => this.modeListeners.delete(cb);
  }

  /** Transition the transport mode and notify listeners (only on a real change). */
  private setMode(mode: TransportMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    for (const cb of this.modeListeners) cb(mode);
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
      // If we're recovering from a polling stint, re-snapshot FIRST so the cursor
      // is a real server seq before we apply this frame (M1). The frame is
      // re-dispatched after catch-up; `dispatch` de-dupes it if the snapshot
      // already carried it.
      if (this.polling) {
        this.polling = false;
        void this.recoverFromPolling(ev);
        return;
      }
      this.attempt = 0; // a delivered frame resets the backoff
      this.setMode("live"); // a delivered SSE frame proves the live transport
      this.applyFrame(ev);
    };

    // Named events (the api sets `event:` to the frame `type`) AND the default
    // `message` channel — covers servers that omit the `event:` line.
    for (const type of NAMED_EVENTS) conn.addEventListener(type, onFrame);
    conn.onmessage = onFrame;
    conn.onerror = () => this.onError();
  }

  /** Parse + dispatch one raw SSE frame; ignores malformed transport frames. */
  private applyFrame(ev: SseMessageEvent): void {
    let payload: unknown;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      return; // ignore malformed transport frames; a bad CONTRACT throws in dispatch
    }
    this.dispatch(payload);
  }

  /**
   * SSE re-opened after a polling fallback (M1). The poll cursor advanced past the
   * real server seq, so we re-run the snapshot catch-up to reset `lastApplied` to
   * an authoritative seq, THEN apply the frame that proved SSE is back. This keeps
   * the resume cursor real so a `tracking_event` at the true next seq is never
   * dropped as a phantom duplicate.
   */
  private async recoverFromPolling(ev: SseMessageEvent): Promise<void> {
    if (this.pollTimer !== null) {
      this.clearT(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.timer !== null) {
      this.clearT(this.timer); // cancel any pending SSE re-probe; this conn is live
      this.timer = null;
    }
    this.lastApplied = -1; // re-derive the cursor from the authoritative snapshot
    await this.catchUp();
    if (this.stopped) return;
    this.attempt = 0;
    this.setMode("live");
    this.applyFrame(ev);
  }

  private onError(): void {
    if (this.stopped) return;
    this.teardownConn();
    if (this.polling) {
      // We're already in the polling fallback with a probe SSE open; that probe
      // failed. Re-arm a fresh probe after a backoff so a later real frame still
      // triggers recovery — but keep the poll loop running and don't re-enter
      // `startPolling`.
      this.setMode("polling");
      this.timer = this.setT(() => this.connect(), this.backoff.maxMs);
      return;
    }
    this.attempt += 1;
    if (this.attempt > this.backoff.maxRetries) {
      this.startPolling(); // SSE exhausted → always-available fallback
      return;
    }
    this.setMode("connecting"); // SSE dropped; reconnecting (badge: not-live yet)
    const delay = Math.min(
      this.backoff.maxMs,
      this.backoff.baseMs * 2 ** (this.attempt - 1),
    );
    this.timer = this.setT(() => this.connect(), delay);
  }

  /**
   * Polling fallback (order streams only). Re-reads the order; `GET /v1/orders/{id}`
   * carries the authoritative `state` — we surface it as a synthetic
   * `tracking_event` so consumers see progress even with SSE down. While polling we
   * ALSO keep an SSE connection open so recovery is detected the moment a real
   * frame lands (`onFrame` → `recoverFromPolling`). Generation streams have no poll
   * endpoint, so they simply stop retrying.
   */
  private startPolling(): void {
    if (this.kind !== "order" || !this.orderId) return;
    if (this.polling) return; // already polling — don't start a second loop
    this.polling = true;
    this.setMode("polling");
    // Keep an SSE attempt alive so the server's next real frame triggers recovery.
    this.connect();
    const tick = async (): Promise<void> => {
      if (this.stopped || !this.polling) return;
      try {
        const order = await this.opts.api.orders.get(this.orderId!);
        // Synthetic frame: advance a SEPARATE poll cursor, never the SSE
        // `lastApplied`. `onEvent` still sees progress; the real resume cursor
        // stays a server seq so SSE recovery doesn't drop the true next frame.
        this.pollSeq += 1;
        const synthetic = {
          type: "tracking_event" as const,
          seq: this.lastApplied + this.pollSeq,
          ts: new Date().toISOString(),
          orderId: order.id,
          state: order.state,
          label: currentStageLabel(order),
          display: order.display,
        };
        // Validate at the boundary, then emit WITHOUT advancing `lastApplied`.
        this.onEvent(RealtimeEventSchema.parse(synthetic));
      } catch {
        // swallow — keep polling; the next tick retries
      }
      if (!this.stopped && this.polling)
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
