# 04 — Real-Time Tracking & Order Simulation Subsystem

> **Status:** Design / Planning (greenfield)
> **Owner:** Real-time Infrastructure
> **Audience:** Backend, Web client, iOS client teams
> **Date:** 2026-06-20

---

## 0. TL;DR (read this first)

The "Dopamine app" places **fake** orders and simulates their fulfillment server-side, pushing live updates to web/iOS clients. There are no real warehouses or couriers — the backend *is* the warehouse and the courier.

The whole point of this subsystem is **extensibility**: today we have **Retail** (slow, multi-stage, state-based) and tomorrow **Food** (fast lifecycle + a live courier-on-a-map geo stream). More verticals will follow. So tracking is a **pluggable subsystem**: a vertical is a `TrackingProvider` (state machine + transition timings + optional geo emitter) that you *register*; everything else (simulation engine, transport, event contracts) is shared and generic.

**Headline recommendations:**

| Concern | Recommendation | Why |
|---|---|---|
| Provider model | `TrackingProvider` strategy interface + a `ProviderRegistry` keyed by `vertical` | Additive: new vertical = new provider + one `register()` line |
| Simulation engine | **Durable job queue** (River for Go / BullMQ for Node) backed by the primary DB/Redis. Reserve Temporal for if/when workflows get genuinely complex. | Survives restarts, simple for a small team, no extra cluster |
| Transport | **Managed pub/sub — Ably** (with Pusher as the lighter alternative); self-hosted Redis+socket gateway only if cost forces it | Reconnect, history/replay, fan-out, presence, multi-region are *solved* and not your code |
| Geo stream | Pre-compute a route with **OSRM** (self-host) → interpolate points server-side → publish at 1–2s on a **separate higher-frequency channel** per order | Plausible road paths, cheap, decoupled cadence from state events |
| Catch-up | **Per-order monotonic `seq`** + a `GET /orders/:id/tracking` snapshot endpoint + channel `rewind`/history on reconnect | No gaps, idempotent, ordered |

---

## 1. Abstractions — the pluggable provider model

### 1.1 Core idea

Every vertical's tracking behavior is captured by **one interface**. The simulation engine and transport never `switch` on vertical — they call the interface. Adding a vertical never edits the engine.

```
                         ┌──────────────────────────────┐
   place order  ───────► │     OrderSimulationEngine      │
   (vertical=food)       │  (generic; durable; restart-   │
                         │   safe scheduler/runner)        │
                         └───────────────┬────────────────┘
                                         │  looks up by vertical
                                         ▼
                         ┌──────────────────────────────┐
                         │       ProviderRegistry         │
                         │  "retail" -> RetailProvider     │
                         │  "food"   -> FoodProvider       │
                         │  "<next>" -> ...                │
                         └───────────────┬────────────────┘
                                         │ implements
                                         ▼
                ┌────────────────────────────────────────────────┐
                │            TrackingProvider (interface)          │
                │  • states() / initialState()                     │
                │  • next(state, ctx) -> (nextState, delay)        │
                │  • emitsGeo() -> bool                            │
                │  • geoPlan(ctx) -> RoutePlan | null              │
                │  • renderEvent(state, ctx) -> StateChangeEvent   │
                └────────────────────────────────────────────────┘
                                         │ publishes
                                         ▼
                         ┌──────────────────────────────┐
                         │   Transport (Ably channels)    │
                         │   order:{id}        (state)     │
                         │   order:{id}:geo    (position)  │
                         └──────────────────────────────┘
```

### 1.2 The interface

Pseudocode (language-agnostic; illustrative only):

```ts
// A transition: the next state and how long (simulated) until we get there.
interface Transition { next: State; delayMs: number; terminal?: boolean }

interface RoutePlan {
  // Ordered lat/lng points (densified) the courier walks along,
  // each with a cumulative timestamp offset from "courier picked up".
  points: { lat: number; lng: number; tOffsetMs: number }[];
  totalMs: number;
}

interface TrackingProvider {
  vertical: string;                       // "retail" | "food" | ...

  states(): State[];                      // declared lifecycle
  initialState(): State;

  // Pure-ish: given current state + order context, what's next and when?
  // Returning null means "stay" or "terminal".
  next(state: State, ctx: OrderCtx): Transition | null;

  // Does this vertical stream a moving location?
  emitsGeo(): boolean;

  // If it does, produce a concrete route to interpolate along.
  // Called once when the geo-emitting phase begins.
  geoPlan(ctx: OrderCtx): RoutePlan | null;

  // Map an internal state to the public, versioned wire event.
  renderEvent(state: State, ctx: OrderCtx): StateChangeEvent;
}
```

`OrderCtx` carries the order id, vertical, items, addresses (fake), `createdAt`, the current `seq`, and a deterministic per-order `seed` (so a given fake order always advances identically — handy for tests and replay).

### 1.3 Retail implementation

Slow, infrequent, **no geo**. Timings are long (we can compress "days" into "minutes" via a global `TIME_SCALE`, or keep them genuinely slow — config, not code).

```ts
class RetailProvider implements TrackingProvider {
  vertical = "retail";
  states() { return ["confirmed","packed","shipped","out_for_delivery","delivered"]; }
  initialState() { return "confirmed"; }
  emitsGeo() { return false; }
  geoPlan() { return null; }

  next(state, ctx) {
    const r = rng(ctx.seed, state);             // deterministic jitter
    switch (state) {
      case "confirmed":        return { next: "packed",           delayMs: hours(2,  r) };
      case "packed":           return { next: "shipped",          delayMs: hours(6,  r) };
      case "shipped":          return { next: "out_for_delivery", delayMs: hours(28, r) };
      case "out_for_delivery": return { next: "delivered",        delayMs: hours(3,  r), terminal: true };
      default:                 return null;
    }
  }
  renderEvent(state, ctx) { /* -> StateChangeEvent, see §5 */ }
}
```

### 1.4 Food implementation

Fast (minutes), **emits geo** during the `en_route` phase.

```ts
class FoodProvider implements TrackingProvider {
  vertical = "food";
  states() { return ["accepted","preparing","picked_up","en_route","arriving","delivered"]; }
  initialState() { return "accepted"; }
  emitsGeo() { return true; }

  next(state, ctx) {
    const r = rng(ctx.seed, state);
    switch (state) {
      case "accepted":  return { next: "preparing", delayMs: secs(20, r) };
      case "preparing": return { next: "picked_up", delayMs: mins(4,  r) };
      case "picked_up": return { next: "en_route",  delayMs: secs(30, r) };  // geo starts here
      case "en_route":  return { next: "arriving",  delayMs: ctx.geo.totalMs - secs(45) };
      case "arriving":  return { next: "delivered", delayMs: secs(45, r), terminal: true };
      default:          return null;
    }
  }

  geoPlan(ctx) {
    // restaurant -> customer, real road geometry from OSRM (see §4)
    return buildRoutePlan(ctx.fromLatLng, ctx.toLatLng, /*avgSpeed*/ 28 /*km/h*/);
  }
  renderEvent(state, ctx) { /* ... */ }
}
```

### 1.5 The registry / strategy selection

```ts
class ProviderRegistry {
  private map = new Map<string, TrackingProvider>();
  register(p: TrackingProvider) { this.map.set(p.vertical, p); }
  get(vertical: string): TrackingProvider {
    const p = this.map.get(vertical);
    if (!p) throw new UnknownVerticalError(vertical);
    return p;
  }
}

// wiring (the ONLY place verticals are enumerated)
registry.register(new RetailProvider());
registry.register(new FoodProvider());
// registry.register(new GroceryProvider());  // tomorrow — one line
```

The engine resolves a provider by the order's `vertical` column and never knows the difference. This is the strategy pattern with a registry; it is the load-bearing extensibility seam of the whole subsystem.

---

## 2. Order simulation engine — how fake orders advance

### 2.1 Requirements

- Advance each order through its provider's state machine on the provider's schedule.
- **Restart-durable**: an in-flight order's progress must survive deploys, crashes, and restarts. A "shipped" order must not silently reset or skip to "delivered".
- Handle **many concurrent** in-flight orders cheaply (food orders are short but numerous; retail orders live for "days").
- Simple to operate for a **small team**.

### 2.2 Options evaluated

| Option | Restart-durable? | Operational weight | Fit |
|---|---|---|---|
| **In-memory timers** (`setTimeout`) | ❌ No — lost on restart | Trivial | Prototype only. Disqualified. |
| **DB-polling state machine** (a `tick` worker scans `orders WHERE next_transition_at <= now`) | ✅ Yes (state in DB) | Low | Solid, simple, transparent. Good baseline. |
| **Durable delayed-job queue** (River/Postgres, BullMQ/Redis) — enqueue the *next* transition as a delayed job | ✅ Yes (job persisted) | Low–Med | **Recommended.** Native delays, retries, cron, backpressure. |
| **Durable workflow engine** (Temporal / Restate) — the lifecycle is literally a function that `sleep()`s between steps | ✅ Yes (event-sourced) | Med–High | Overkill now; great if logic gets gnarly. |
| **Actor model** (one actor per order) | Depends on persistence layer | High | Elegant but heavy infra for a small team. |

### 2.3 Recommendation: durable delayed-job queue (with a polling fallback)

Model each **state transition as a delayed job**:

1. On order create: persist the order row (`state = initialState`, `seq = 0`), then enqueue `advance(orderId)` with `delay = next().delayMs`.
2. The `advance` worker: load order → `provider.next(state)` → in **one DB transaction** update `state`, bump `seq`, write a `tracking_event` row → publish to transport → enqueue the *next* `advance` job (unless terminal).
3. For geo-emitting phases, the worker that enters `en_route` enqueues a geo-emitter job (see §4) instead of/in addition to the next state job.

**Why a job queue over raw polling:** native delayed execution (no `WHERE next_at <= now` scan thundering herd), built-in retries with backoff, dead-letter handling, cron/periodic support, and visibility — all without standing up a separate cluster.

- **Go shops → [River](https://riverqueue.com/)**: Postgres-backed, transaction-safe ("jobs never run before your transaction completes, and are never lost"), supports periodic/scheduled jobs. No extra service beyond the DB you already have. ([River docs](https://github.com/riverqueue/river/blob/master/docs/README.md))
- **Node shops → [BullMQ](https://docs.bullmq.io/)**: Redis-backed, mature, native delayed jobs. (ToolJet notably [replaced Temporal with BullMQ](https://docs.tooljet.com/docs/setup/workflow-temporal-to-bullmq-migration/) to simplify ops while keeping functionality.)

**Restart-durability guarantee:** the only source of truth is the DB row + the persisted job. A restart re-attaches workers to the queue; pending delayed jobs fire at their scheduled time. Crucially, the transition write and the next-job enqueue are **transactional** (River does this natively on Postgres; with BullMQ use an outbox row + idempotent re-enqueue) so we never end in "state advanced but next step never scheduled" or vice versa.

**Why not Temporal yet:** Temporal is excellent — durable execution where you write the lifecycle as code that `sleep()`s for hours and the platform replays event history to survive crashes ([Temporal](https://temporal.io/)). But for a small team it adds a cluster (or [Temporal Cloud](https://docs.temporal.io/cloud/pricing) at ~$50/M Actions) and a determinism programming model to learn. Our state machines are simple and declarative; a job queue covers restart-durability without that tax. **Revisit Temporal if** transitions grow side-effect-heavy (payments, sagas, human-in-the-loop, compensations) — the provider interface is unchanged; only the engine's "how I schedule next()" swaps out. We keep that boundary clean precisely so this is a swap, not a rewrite.

### 2.4 Idempotency & exactly-once-ish

Jobs are at-least-once (any queue can redeliver). Make `advance` idempotent: it carries the `expectedSeq`/`fromState`; if the order isn't in `fromState` anymore, it's a no-op. Publishing uses the order's `seq` as the message id so duplicate publishes dedupe downstream (§6).

```
advance(orderId, fromState, fromSeq):
  BEGIN
    o = SELECT ... FOR UPDATE
    if o.state != fromState OR o.seq != fromSeq: COMMIT; return   // already done
    t = provider.next(o.state, ctx)
    UPDATE orders SET state=t.next, seq=seq+1, next_at=...
    INSERT tracking_event(orderId, seq=o.seq+1, type='state', payload=...)
  COMMIT
  publish(channel=order:{id}, msg)         // id = seq  (idempotent downstream)
  if !t.terminal: enqueue advance(orderId, t.next, o.seq+1, delay=t.delayMs)
```

---

## 3. Real-time transport to clients

### 3.1 Requirements

Fan-out to many subscribers per order (you, friends watching your fake order), **reconnection** with **backfill/replay** (no missed state changes), auth, and scale to many concurrent trackers — including a higher-frequency geo channel for food.

### 3.2 Options

| Option | Reconnect+replay | Fan-out | Auth | Ops for small team | Notes |
|---|---|---|---|---|---|
| **Raw WebSockets (self-hosted)** | You build it | You build it | You build it | High | WS does **not** auto-reconnect; you implement backoff + gap recovery yourself ([getstream](https://getstream.io/blog/websocket-sse/)). |
| **SSE (self-hosted)** | **Built-in** via `Last-Event-ID` → server replays ([oneuptime](https://oneuptime.com/blog/post/2026-01-27-sse-vs-websockets/view)) | You build it | Standard HTTP | Low–Med | One-way (server→client) — perfect for tracking; client→server stays plain HTTP POST. |
| **Redis pub/sub + socket gateway (self-hosted)** | You build it | Redis handles | You build it | **High** | Most control, most code. Pub/sub is fire-and-forget → you must add a replay store. |
| **Managed: Ably** | **Built-in** (history, `rewind`, connection state recovery) | Managed | Token auth | **Low** | Strong delivery guarantees; multi-region; presence. **Recommended.** |
| **Managed: Pusher** | Limited history | Managed | Token auth | **Low** | Simpler/cheaper; good if guarantees are non-critical. |
| **Managed: Supabase Realtime** | DB-change driven | Managed | RLS/JWT | Low | Great if you're all-in on Supabase Postgres; 500 concurrent conns on Pro, then package pricing ([Supabase](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-peak-connections)). |

### 3.3 Recommendation: managed pub/sub, default **Ably**

For a small team, the reconnection/replay/fan-out/auth/multi-region problems are *exactly* what you do not want to hand-build. Ably gives:

- **Reconnection + continuity**: automatic resume of connection state; if disconnected < ~2 min it resumes transparently, and you can use channel **`rewind`** to fetch the last N messages on attach, or **history** to backfill a window ([Ably rewind](https://ably.com/docs/channels/options/rewind), [Ably history](https://ably.com/docs/storage-history/history)). This is our gap-free catch-up (§6) without writing a replay store.
- **Delivery guarantees**: ordered, exactly-once semantics on a channel — stronger than Pusher, which is "simpler to integrate for non-critical features" ([Ably vs Pusher](https://ably.com/compare/pusher-vs-supabase)).
- **Fan-out & presence**: many subscribers per `order:{id}` channel for free; presence if we later show "3 friends watching."
- **Auth**: issue short-lived **token requests** from our backend scoped to the channels a user may read (their own orders). Clients never hold a root key.

**When to pick Pusher instead:** if cost matters more than guarantees and we can tolerate occasional gaps (we mostly can, because we *also* expose a snapshot endpoint, §6). Pusher's model is simpler; free Sandbox is 200 concurrent connections.

**When to self-host (Redis pub/sub + gateway):** only if managed messaging cost becomes the dominant line item at scale (§7). Pub/sub alone is fire-and-forget; we'd have to add a Redis Stream (or the `tracking_event` table) as the replay log and build the SSE/WS gateway + reconnect logic ourselves. Keep the **same event contract** (§5) so this remains a transport swap, not a client rewrite. **If we self-host, prefer SSE over raw WS** for the state channel — its built-in `Last-Event-ID` replay gives us reconnection for nearly free; the geo channel can stay SSE too (it's server→client only).

### 3.4 Abstraction boundary

Wrap the transport behind a tiny internal interface so providers/engine never import the SDK directly:

```ts
interface TrackingTransport {
  publishState(orderId: string, ev: StateChangeEvent): Promise<void>;
  publishGeo(orderId: string, ev: GeoPositionEvent): Promise<void>;
  // client-side token minting lives in an HTTP route, not here
}
```

Swapping Ably → Pusher → self-hosted touches **one class**.

---

## 4. Geo / courier streaming (food)

### 4.1 Generating a plausible path

We need a courier that moves along **real roads**, not a straight line. Pre-compute the route once when the geo phase begins:

- **Recommended: self-hosted [OSRM](http://project-osrm.org/)**. It's the logistics-industry reference for fast routing without per-request API fees; returns geometry as **encoded polyline (precision 5)** — the same scheme Google/Mapbox use, so clients decode it trivially ([afi.io](https://blog.afi.io/blog/osrm-route-api-free-directions-api-with-turn-by-turn-directions-and-polylines/), [Telenav OSRM vs Valhalla](https://github.com/Telenav/open-source-spec/blob/master/osrm/doc/osrm-vs-valhalla.md)). One Docker container + an OSM extract for our metro areas.
- **Alternatives**: **Valhalla** (more dynamic/tunable, OSRM-compatible response format) or **GraphHopper** if we want richer options; **Mapbox Directions** if we want zero infra at the cost of rate limits and "hundreds to thousands monthly at scale" ([ayedo](https://ayedo.de/en/posts/osrm-die-referenz-architektur-fur-blitzschnelles-routing-logistik-ohne-api-kosten/)).

> Since orders are **fake**, we don't even need live traffic — a static OSRM extract is plenty, and it's free to run.

### 4.2 Server-side interpolation → emit

`geoPlan()` returns a densified `RoutePlan` (points with cumulative time offsets). A **geo-emitter job** for that order:

```
on enter en_route:
  plan = provider.geoPlan(ctx)          // OSRM route, densified
  startTs = now()
  loop every CADENCE (1–2s) until plan.totalMs elapsed:
     elapsed = now() - startTs
     pos = interpolateAlong(plan, elapsed)   // lerp between bracketing points
     publishGeo(orderId, { seq++, lat, lng, bearing, etaMs })
  // 'arriving'/'delivered' handled by the state machine
```

Interpolation = find the two route points bracketing `elapsed`, linearly interpolate lat/lng, derive bearing from the segment. This is cheap CPU and uses no further OSRM calls.

### 4.3 Cadence, bandwidth, cost

- **Cadence: 1–2s** server emit is plenty; the client **smooths between points** (animate the marker over the interval, ease-in/out), so even 2–3s looks fluid. Don't go below 1s — bandwidth and message cost rise with no UX gain.
- **Bandwidth**: a geo event is ~40–60 bytes of JSON. At 1.5s cadence a 10-minute delivery ≈ 400 messages ≈ ~20 KB total per order. Negligible per client.
- **Cost lever**: with managed pub/sub you pay per message — geo is the dominant message source. Knobs: cadence, and only emit geo while the tracking screen is **foregrounded/subscribed** (presence-gate it). A backgrounded client doesn't need 1.5s updates.

### 4.4 Layering on the same transport

Geo rides the **same transport** as a **separate, higher-frequency channel** per order:

```
order:{id}        → low-frequency StateChangeEvent  (a handful per order)
order:{id}:geo    → high-frequency GeoPositionEvent  (every 1–2s, food only)
```

Two channels means clients subscribe to geo **only when needed** (food + map screen open), state and geo have independent `seq` sequences and replay windows, and retail clients never touch geo at all. The transport, contracts, and catch-up logic are identical — geo is "just another channel," which is exactly what makes it additive.

---

## 5. Event model & contracts (client teams: this is your dependency)

All events are JSON, **versioned**, carry a per-channel monotonic **`seq`**, and a server `ts` (ms epoch). Two event families on two channel families.

### 5.1 Channels

| Channel | Purpose | Frequency | Who subscribes |
|---|---|---|---|
| `order:{orderId}` | State-change events | Low (per transition) | All verticals |
| `order:{orderId}:geo` | Geo position events | High (1–2s) | Food (map open) only |

### 5.2 `StateChangeEvent` (channel `order:{orderId}`)

```jsonc
{
  "v": 1,                          // schema version
  "type": "state_change",
  "orderId": "ord_abc123",
  "vertical": "food",              // or "retail", ...
  "seq": 4,                        // monotonic per (channel, order)
  "state": "en_route",             // value from provider.states()
  "displayState": "On the way",    // human label (server-localizable)
  "progress": 0.66,                // 0..1 hint for progress bars
  "etaMs": 540000,                 // optional: ms until delivered (nullable)
  "geoActive": true,               // is order:{id}:geo live right now?
  "ts": 1750454400000,
  "meta": { /* vertical-specific, optional, additive only */ }
}
```

- `state` is the **machine** value (stable, switchable in client logic); `displayState` is presentation. Clients should switch on `state`, render `displayState`.
- `state` values differ per vertical **by design** — clients render whatever the provider declares; they must not hardcode a single global enum. (They may keep per-vertical enums.)
- `terminal` states: `delivered` (and future `cancelled`). After terminal, channels close server-side.

### 5.3 `GeoPositionEvent` (channel `order:{orderId}:geo`)

```jsonc
{
  "v": 1,
  "type": "geo_position",
  "orderId": "ord_abc123",
  "seq": 128,                      // separate sequence from the state channel
  "lat": 37.7763,
  "lng": -122.4171,
  "bearing": 218.4,               // degrees, for marker rotation
  "speedKph": 27.5,               // optional
  "etaMs": 420000,
  "ts": 1750454411000
}
```

Optionally, on the **first** geo event after subscribe, include `"route": "<encoded polyline>"` so the client can draw the full path immediately (or fetch it from the snapshot endpoint, §6).

### 5.4 Subscription API (client-facing)

1. **Mint a token** (auth gate): `POST /realtime/token` → returns a short-lived transport token **scoped to the channels for orders the user owns**. (Ably token request / Pusher auth signature / SSE: a signed cookie.)
2. **Subscribe** via the transport SDK:
   - `order:{orderId}` always.
   - `order:{orderId}:geo` only when `geoActive: true` **and** the map screen is open.
3. **Snapshot/catch-up**: `GET /orders/{orderId}/tracking` (see §6) before/at subscribe time.

**Contract stability rules** (so clients don't break):
- Schema is **additive**: new optional fields any time; removing/renaming fields ⇒ bump `v`.
- `seq` is **per channel, per order, gap-free, monotonic** starting at 0/1.
- Unknown `state` values must degrade gracefully on clients (show `displayState`).

---

## 6. Consistency & catch-up (mid-order joins, no gaps)

### 6.1 The snapshot + stream pattern

When a client opens a tracking screen, the order may already be mid-flight. Sequence:

```
Client                         Backend / Transport
  │  GET /orders/{id}/tracking   │
  │ ───────────────────────────► │  returns current snapshot:
  │                              │   { state, seq:S, geoActive, route?, lastGeo? }
  │ ◄─────────────────────────── │
  │  subscribe order:{id}         │
  │     with rewind / sinceSeq=S  │   transport replays msgs with seq > S
  │ ───────────────────────────► │
  │ ◄═══════ live events ════════ │
```

- **Snapshot endpoint** `GET /orders/{id}/tracking` returns the *authoritative current* state and the latest `seq` for both channels, plus (for food) the encoded `route` and last known position. This is read straight from `orders` + latest `tracking_event` rows.
- **Then subscribe with replay from `seq`**: Ably **`rewind`**/history replays messages after the snapshot's `seq`; with SSE we send `Last-Event-ID: S` and the server replays from the `tracking_event` log. Either way, **no gap** between snapshot and live tail.

### 6.2 Ordering, dedup, idempotency

- **Ordering**: clients **apply events in `seq` order** and **drop any `seq <= lastApplied`** (handles duplicates and out-of-order redelivery). The engine never reuses a `seq`.
- **Dedup**: message id = `seq`. At-least-once publish (§2.4) is safe because the client and any downstream consumer dedupe by `seq`.
- **Geo gaps are tolerable**: a dropped geo frame just means the marker animates to the next one — clients should **interpolate toward the newest** position rather than queue stale frames. (State events are *not* droppable; geo events are.)
- **Clock**: clients trust server `ts`/`etaMs`, never local time, for progress/ETA.

### 6.3 Source of truth

The DB (`orders` + `tracking_event` append-only log) is authoritative; the transport is a delivery accelerator. If transport and DB ever disagree, the snapshot endpoint (DB) wins. This is what lets us swap transports without correctness risk.

---

## 7. Scaling & cost

### 7.1 Simulation engine scaling

- **Cost driver**: number of **concurrent in-flight** orders, and geo cadence for food.
- Job-queue workers scale **horizontally and independently** of the API. Food orders are short-lived but bursty (lunch/dinner); retail orders are long-lived but cheap (a transition every few hours).
- **Geo-emitter jobs are the hot path**: a 10-min food delivery at 1.5s cadence = a worker loop ticking ~400 times. Keep these on a **dedicated worker pool** sized to peak concurrent active deliveries (not total orders). Backpressure: if behind, drop to a longer cadence — geo is droppable.
- DB writes: only **state transitions** write to `tracking_event` (rare). Geo positions are **published, not persisted per frame** (persist only periodic checkpoints, or none — they're reconstructable from the route + elapsed time). This keeps the append log small.

### 7.2 Transport / connection scaling

- **Connection ceiling** is per-client, not per-order; one socket multiplexes all of a user's order channels. So conns ≈ concurrent active users, not orders.
- Managed (Ably/Pusher) **scales connections and fan-out for you**; you size with a paid tier. Self-hosted SSE/WS gateways scale by adding stateless gateway nodes behind a load balancer, with Redis pub/sub for cross-node fan-out — but **you own** reconnection, replay store, and capacity planning.
- **Sticky routing** isn't required with SSE-from-snapshot (any node can serve replay from the shared `tracking_event` log).

### 7.3 Managed vs self-hosted cost trade-off

| | Managed (Ably/Pusher) | Self-hosted (Redis + gateway) |
|---|---|---|
| Eng time to build | ~days | weeks (reconnect, replay, scaling) |
| Marginal cost | per message + per connection-minute | infra + your on-call time |
| Where it bites | **geo messages** (high frequency) dominate the bill | engineering + ops, not per-message |
| Best when | small team, low/medium scale, want guarantees | very high message volume makes per-msg pricing dominate |

Concrete anchors (verify before committing): Supabase Pro = 500 concurrent conns then **per-1,000-connection packages** ([Supabase](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-peak-connections)); Ably bills **connection-minutes + messages** with rewind/history included ([Ably pricing](https://ably.com/docs/platform/pricing)); Temporal Cloud (if used for the engine) ≈ **$50/M Actions** and avoids the ~$26K+/mo true cost of self-hosting a Temporal cluster ([Temporal pricing update](https://temporal.io/blog/temporal-cloud-pricing-update)).

**Cost-control levers (in priority order):** (1) presence-gate geo so backgrounded clients stop the high-frequency stream; (2) tune geo cadence (1.5s vs 1s ≈ 33% fewer messages); (3) one multiplexed connection per user; (4) only food + map-open subscribes to geo.

### 7.4 Rough budget intuition

Geo dominates everything. If geo is gated to "food order + foreground map," the message bill tracks **concurrent active deliveries being watched**, not total users. That's a small, controllable number — managed pub/sub stays cheap until product-market fit, at which point §7.3's self-host escape hatch exists *behind the same contract*.

---

## 8. Extensibility walkthrough — adding a new vertical

Concrete example: **add Grocery** (lifecycle: `placed → shopping → checkout → en_route → delivered`, with a live courier map like food).

A developer does **only** this:

1. **Implement the provider** — one new file, `GroceryProvider implements TrackingProvider`:
   - `states()` / `initialState()` — the new lifecycle.
   - `next(state, ctx)` — transition timings (with `rng(seed)` jitter).
   - `emitsGeo() => true`, `geoPlan(ctx)` — reuse the shared OSRM route builder (store→customer).
   - `renderEvent()` — map states to `StateChangeEvent` (`displayState`, `progress`).
2. **Register it** — one line: `registry.register(new GroceryProvider());`
3. **Done.** No other changes:
   - Engine: already generic — resolves provider by `vertical`, schedules `next()`, runs the geo-emitter if `emitsGeo()`.
   - Transport: already generic — publishes to `order:{id}` and `order:{id}:geo`.
   - Contracts: unchanged — `state` values are provider-declared; clients render `displayState`; `seq`/snapshot/catch-up all identical.
   - Geo: free, because it's the same channel + interpolation machinery.

```
NEW vertical cost  =  1 provider class  +  1 register() line
UNCHANGED          =  engine, transport, event schema, catch-up, geo pipeline
```

Client side: a grocery screen reuses the generic tracking components (subscribe → snapshot → stream → render `displayState`/`progress`, and the same map view as food when `geoActive`). The client work is UI, not protocol — because the protocol is vertical-agnostic.

### What would force a bigger change (and why our seams contain it)
- **Complex transition side-effects** (sagas/compensation): swap the *engine's* scheduler to Temporal — providers and contracts untouched (§2.3).
- **Transport cost blow-up**: swap Ably → self-hosted SSE — clients untouched because the **event contract** is the boundary (§3.3, §5).
- **A non-linear lifecycle** (branches/parallel states): `next()` already returns the next transition from arbitrary logic; branch on `ctx`. Still additive.

---

## Appendix A — Data model sketch

```sql
orders (
  id            text primary key,
  user_id       text not null,
  vertical      text not null,              -- registry key
  state         text not null,
  seq           bigint not null default 0,  -- state-channel sequence
  geo_seq       bigint not null default 0,  -- geo-channel sequence
  seed          bigint not null,            -- deterministic per-order RNG
  next_at       timestamptz,                -- next scheduled transition
  route_poly    text,                       -- encoded polyline (food/grocery)
  created_at    timestamptz not null,
  terminal_at   timestamptz
);

tracking_event (                            -- append-only state log (replay source)
  order_id   text not null,
  seq        bigint not null,
  type       text not null,                 -- 'state_change'
  payload    jsonb not null,
  ts         timestamptz not null,
  primary key (order_id, seq)
);
-- geo positions intentionally NOT persisted per-frame (reconstructable from route+time)
```

## Appendix B — Decision log

| Decision | Choice | Reversible? | Behind which seam |
|---|---|---|---|
| Provider model | strategy + registry | n/a (the seam) | — |
| Engine | durable job queue (River/BullMQ) | yes → Temporal | `TrackingProvider` ↔ engine |
| Transport | Ably (managed) | yes → Pusher / self-host SSE | event contract (§5) |
| Routing | self-host OSRM | yes → Valhalla/Mapbox | `geoPlan()` |
| Catch-up | snapshot + seq replay | n/a | snapshot endpoint + `seq` |

---

## Sources

- [SSE vs WebSockets — OneUptime](https://oneuptime.com/blog/post/2026-01-27-sse-vs-websockets/view) · [GetStream](https://getstream.io/blog/websocket-sse/) · [Railway](https://docs.railway.com/guides/sse-vs-websockets)
- [Ably pricing](https://ably.com/docs/platform/pricing) · [Ably rewind](https://ably.com/docs/channels/options/rewind) · [Ably history](https://ably.com/docs/storage-history/history) · [Pusher vs Supabase (Ably)](https://ably.com/compare/pusher-vs-supabase)
- [Supabase Realtime peak connections](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-peak-connections)
- [River queue](https://riverqueue.com/) · [River docs](https://github.com/riverqueue/river/blob/master/docs/README.md) · [BullMQ](https://docs.bullmq.io/) · [ToolJet Temporal→BullMQ](https://docs.tooljet.com/docs/setup/workflow-temporal-to-bullmq-migration/)
- [Temporal](https://temporal.io/) · [Temporal Cloud pricing](https://docs.temporal.io/cloud/pricing) · [Temporal pricing update](https://temporal.io/blog/temporal-cloud-pricing-update)
- [OSRM vs Valhalla (Telenav)](https://github.com/Telenav/open-source-spec/blob/master/osrm/doc/osrm-vs-valhalla.md) · [OSRM polylines (afi.io)](https://blog.afi.io/blog/osrm-route-api-free-directions-api-with-turn-by-turn-directions-and-polylines/) · [OSRM as logistics reference (ayedo)](https://ayedo.de/en/posts/osrm-die-referenz-architektur-fur-blitzschnelles-routing-logistik-ohne-api-kosten/) · [Routing engines compared 2026 (Pi Stack)](https://www.pistack.xyz/posts/2026-04-25-graphhopper-vs-osrm-vs-valhalla-self-hosted-routing-engines-guide-2026/)
