import {
  type RealtimeEvent,
  type TrackingEvent,
  type TrackingSnapshot,
} from "@dopamine/contracts";
import { describe, expect, it, vi } from "vitest";

import { type ApiClient } from "./client.js";
import {
  type EventSourceFactory,
  type SseConnection,
  type SseMessageEvent,
} from "./event-source.js";
import { TrackingClient } from "./tracking-client.js";

/** A controllable fake EventSource — drive frames + errors from the test. */
class FakeEventSource implements SseConnection {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: SseMessageEvent) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  readonly url: string;
  private readonly listeners = new Map<
    string,
    ((ev: SseMessageEvent) => void)[]
  >();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (ev: SseMessageEvent) => void,
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  /** Push a named frame, as the api would (`event:` line = the type). */
  emit(type: string, event: RealtimeEvent): void {
    const ev: SseMessageEvent = {
      data: JSON.stringify(event),
      lastEventId: String(event.seq),
    };
    for (const l of this.listeners.get(type) ?? []) l(ev);
    this.onmessage?.(ev);
  }

  fail(): void {
    this.onerror?.(new Error("sse failed"));
  }

  close(): void {
    this.closed = true;
  }
}

function trackingEvent(seq: number, state: string): TrackingEvent {
  return {
    type: "tracking_event",
    seq,
    ts: `2026-06-21T12:00:0${String(seq)}.000Z`,
    orderId: "ord_1",
    state,
    label: state,
  };
}

function makeApi(
  snapshot: TrackingSnapshot,
  orderGet?: () => ReturnType<ApiClient["orders"]["get"]>,
) {
  const trackingSnapshot = vi.fn(() => Promise.resolve(snapshot));
  const get =
    orderGet ??
    vi.fn(() =>
      Promise.resolve({
        id: "ord_1",
        verticalId: "retail",
        storefrontId: "sto_1",
        state: "delivered",
        items: [],
        total: { amount_cents: 0, currency: "USD" },
        display: {
          stages: [
            {
              key: "delivered",
              label: "Delivered",
              reached: true,
              current: true,
            },
          ],
          trackingMode: "timeline" as const,
        },
        capabilities: { liveLocation: false },
        streamUrl: "/v1/orders/ord_1/stream",
        placedAt: "2026-06-21T12:00:00.000Z",
      }),
    );
  const api = {
    orders: { trackingSnapshot, get },
  } as unknown as ApiClient;
  return { api, trackingSnapshot, get };
}

/** Synchronous fake timer queue so backoff/poll are deterministic. */
function fakeTimers() {
  const queue: { cb: () => void }[] = [];
  return {
    setTimeout: (cb: () => void) => {
      const entry = { cb };
      queue.push(entry);
      return entry;
    },
    clearTimeout: (h: unknown) => {
      const i = queue.indexOf(h as { cb: () => void });
      if (i >= 0) queue.splice(i, 1);
    },
    flush: () => {
      while (queue.length) {
        const entry = queue.shift()!;
        entry.cb();
      }
    },
    pending: () => queue.length,
  };
}

const emptySnapshot: TrackingSnapshot = {
  orderId: "ord_1",
  state: "confirmed",
  display: {
    stages: [
      { key: "confirmed", label: "Confirmed", reached: true, current: true },
    ],
    trackingMode: "timeline",
  },
  events: [],
  latestSeq: -1,
};

describe("TrackingClient — snapshot-first catch-up", () => {
  it("replays the snapshot event log before streaming", async () => {
    FakeEventSource.instances = [];
    const snapshot: TrackingSnapshot = {
      ...emptySnapshot,
      events: [trackingEvent(0, "confirmed"), trackingEvent(1, "packed")],
      latestSeq: 1,
    };
    const { api } = makeApi(snapshot);
    const applied: RealtimeEvent[] = [];
    const factory: EventSourceFactory = (url) => new FakeEventSource(url);

    const client = new TrackingClient({
      api,
      eventSourceFactory: factory,
      baseUrl: "http://api.test",
      getToken: () => "t",
    });
    client.trackOrder("ord_1", (e) => applied.push(e));
    await vi.waitFor(() => expect(applied.length).toBe(2));

    expect(applied.map((e) => e.seq)).toEqual([0, 1]);
  });
});

describe("TrackingClient — seq ordering + de-dupe", () => {
  it("applies in seq order and drops seq <= lastApplied", async () => {
    FakeEventSource.instances = [];
    const { api } = makeApi({ ...emptySnapshot, latestSeq: 2, events: [] });
    const applied: RealtimeEvent[] = [];
    const client = new TrackingClient({
      api,
      eventSourceFactory: (url) => new FakeEventSource(url),
      baseUrl: "http://api.test",
      getToken: () => "t",
    });
    client.trackOrder("ord_1", (e) => applied.push(e));
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0]!;

    es.emit("tracking_event", trackingEvent(1, "stale")); // <= lastApplied(2) → dropped
    es.emit("tracking_event", trackingEvent(2, "dupe")); // == lastApplied → dropped
    es.emit("tracking_event", trackingEvent(3, "shipped")); // applied
    es.emit("tracking_event", trackingEvent(3, "replay")); // == lastApplied now → dropped
    es.emit("tracking_event", trackingEvent(4, "delivered")); // applied

    expect(applied.map((e) => e.seq)).toEqual([3, 4]);
    expect(
      applied.map((e) => (e.type === "tracking_event" ? e.state : "")),
    ).toEqual(["shipped", "delivered"]);
  });

  it("passes the lastApplied cursor on the SSE URL (Last-Event-ID resume)", async () => {
    FakeEventSource.instances = [];
    const { api } = makeApi({ ...emptySnapshot, latestSeq: 7, events: [] });
    const client = new TrackingClient({
      api,
      eventSourceFactory: (url) => new FakeEventSource(url),
      baseUrl: "http://api.test",
      getToken: () => "tok",
    });
    client.trackOrder("ord_1", () => {});
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const url = FakeEventSource.instances[0]!.url;
    expect(url).toContain("lastEventId=7");
    expect(url).toContain("token=tok");
    expect(url).toContain("/v1/orders/ord_1/stream");
  });
});

describe("TrackingClient — backoff → polling fallback", () => {
  it("reconnects with backoff, then falls back to polling GET /v1/orders/{id}", async () => {
    FakeEventSource.instances = [];
    const timers = fakeTimers();
    const orderGet = vi.fn(() =>
      Promise.resolve({
        id: "ord_1",
        verticalId: "retail",
        storefrontId: "sto_1",
        state: "out_for_delivery",
        items: [],
        total: { amount_cents: 0, currency: "USD" },
        display: {
          stages: [
            { key: "shipped", label: "Shipped", reached: true, current: false },
            {
              key: "out_for_delivery",
              label: "Out for delivery",
              reached: true,
              current: true,
            },
          ],
          trackingMode: "timeline" as const,
        },
        capabilities: { liveLocation: false },
        streamUrl: "/v1/orders/ord_1/stream",
        placedAt: "2026-06-21T12:00:00.000Z",
      }),
    );
    const { api, get } = makeApi(
      { ...emptySnapshot, latestSeq: 0, events: [] },
      orderGet,
    );
    const applied: RealtimeEvent[] = [];

    const client = new TrackingClient({
      api,
      eventSourceFactory: (url) => new FakeEventSource(url),
      baseUrl: "http://api.test",
      getToken: () => "t",
      backoff: { baseMs: 1, maxMs: 1, maxRetries: 2, pollIntervalMs: 1 },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const sub = client.trackOrder("ord_1", (e) => applied.push(e));
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    // Fail attempt 1 → schedules reconnect; flush runs it (creates ES #2).
    FakeEventSource.instances[0]!.fail();
    timers.flush();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(2));

    // Fail attempt 2 → reconnect (ES #3).
    FakeEventSource.instances[1]!.fail();
    timers.flush();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(3));

    // Fail attempt 3 (> maxRetries=2) → polling fallback kicks in.
    FakeEventSource.instances[2]!.fail();
    await vi.waitFor(() => expect(get).toHaveBeenCalled());

    // The polled order surfaces as a synthetic tracking_event.
    expect(applied.length).toBeGreaterThan(0);
    expect(applied[applied.length - 1]!.type).toBe("tracking_event");
    sub.stop();
  });
});

describe("TrackingClient — transport mode reporting (H1)", () => {
  it("flips mode to polling when SSE errors, and back to live on reconnect", async () => {
    FakeEventSource.instances = [];
    const timers = fakeTimers();
    const { api } = makeApi({ ...emptySnapshot, latestSeq: 0, events: [] });

    const client = new TrackingClient({
      api,
      eventSourceFactory: (url) => new FakeEventSource(url),
      baseUrl: "http://api.test",
      getToken: () => "t",
      backoff: { baseMs: 1, maxMs: 1, maxRetries: 1, pollIntervalMs: 1 },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const sub = client.trackOrder("ord_1", () => {});
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    const modes: string[] = [];
    sub.onModeChange((m) => modes.push(m));

    // A delivered SSE frame proves the live transport.
    FakeEventSource.instances[0]!.emit("tracking_event", trackingEvent(1, "packed"));
    expect(sub.getMode()).toBe("live");

    // Exhaust SSE retries → polling fallback.
    FakeEventSource.instances[0]!.fail(); // attempt 1 → reconnect scheduled
    timers.flush();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
    FakeEventSource.instances[1]!.fail(); // attempt 2 (> maxRetries=1) → polling
    await vi.waitFor(() => expect(sub.getMode()).toBe("polling"));

    // While polling the SDK keeps a probe SSE open; a real frame on it recovers.
    const probe = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    probe.emit("tracking_event", trackingEvent(1, "shipped"));
    await vi.waitFor(() => expect(sub.getMode()).toBe("live"));

    expect(modes).toContain("polling");
    expect(modes[modes.length - 1]).toBe("live");
    sub.stop();
  });
});

describe("TrackingClient — poll→live seq drift (M1)", () => {
  it("does NOT drop a real frame at the true next seq after a polling stint", async () => {
    FakeEventSource.instances = [];
    const timers = fakeTimers();
    // Snapshot's authoritative cursor is seq 5 (latestSeq), no replay events.
    const snapshot: TrackingSnapshot = { ...emptySnapshot, latestSeq: 5, events: [] };
    const trackingSnapshot = vi.fn(() => Promise.resolve(snapshot));
    const get = vi.fn(() =>
      Promise.resolve({
        id: "ord_1",
        verticalId: "retail",
        storefrontId: "sto_1",
        state: "out_for_delivery",
        items: [],
        total: { amount_cents: 0, currency: "USD" },
        display: {
          stages: [
            { key: "out_for_delivery", label: "Out for delivery", reached: true, current: true },
          ],
          trackingMode: "timeline" as const,
        },
        capabilities: { liveLocation: false },
        streamUrl: "/v1/orders/ord_1/stream",
        placedAt: "2026-06-21T12:00:00.000Z",
      }),
    );
    const api = { orders: { trackingSnapshot, get } } as unknown as ApiClient;

    const applied: RealtimeEvent[] = [];
    const client = new TrackingClient({
      api,
      eventSourceFactory: (url) => new FakeEventSource(url),
      baseUrl: "http://api.test",
      getToken: () => "t",
      backoff: { baseMs: 1, maxMs: 1, maxRetries: 1, pollIntervalMs: 1 },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const sub = client.trackOrder("ord_1", (e) => applied.push(e));
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    // Drive into the polling fallback.
    FakeEventSource.instances[0]!.fail();
    timers.flush();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
    FakeEventSource.instances[1]!.fail();
    await vi.waitFor(() => expect(sub.getMode()).toBe("polling"));

    // Polling emits synthetic frames (≥1). These must NOT advance the SSE cursor.
    await vi.waitFor(() => expect(applied.length).toBeGreaterThan(0));
    const beforeRecovery = applied.length;
    expect(get).toHaveBeenCalled();

    // SSE recovers: a REAL frame at the TRUE next seq (6 = latestSeq+1) arrives on
    // the probe connection. With the old code the synthetic poll frame had already
    // claimed seq 6, so this real frame would be dropped as a dup. It must apply.
    const probe = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    probe.emit("tracking_event", trackingEvent(6, "delivered"));
    await vi.waitFor(() => expect(trackingSnapshot).toHaveBeenCalledTimes(2)); // re-snapshot
    await vi.waitFor(() =>
      expect(
        applied.some((e) => e.seq === 6 && e.type === "tracking_event" && e.state === "delivered"),
      ).toBe(true),
    );
    expect(applied.length).toBeGreaterThan(beforeRecovery);
    sub.stop();
  });
});

describe("TrackingClient — generation stream reuses the core", () => {
  it("connects to the generation stream and applies images.ready frames", async () => {
    FakeEventSource.instances = [];
    const { api } = makeApi(emptySnapshot);
    const applied: RealtimeEvent[] = [];
    const client = new TrackingClient({
      api,
      eventSourceFactory: (url) => new FakeEventSource(url),
      baseUrl: "http://api.test",
      getToken: () => "t",
    });
    client.trackGeneration("gen_1", (e) => applied.push(e));
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toContain("/v1/generation/gen_1/stream");

    es.emit("images.ready", {
      type: "images.ready",
      seq: 1,
      ts: "2026-06-21T12:00:01.000Z",
      generation_id: "gen_1",
      media: {
        status: "ready",
        hero: {
          url: "http://minio/x.png",
          kind: "image",
          blurhash: null,
          aspect_ratio: 1,
        },
        alternates: [],
        expected_ready_ms: null,
        generation_id: "gen_1",
      },
    });

    expect(applied).toHaveLength(1);
    expect(applied[0]!.type).toBe("images.ready");
  });
});
