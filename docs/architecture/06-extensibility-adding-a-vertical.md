# 06 — Extensibility Walkthrough: Adding the Food Vertical

> This is the **proof that the architecture is extensible**. It traces, layer by
> layer, exactly what a developer changes to add **food ordering** (fast
> lifecycle + live courier-on-a-map) on top of the existing **retail** vertical —
> and, just as importantly, what they **don't** touch. If adding a vertical here
> requires editing core platform code or bumping the API version, the design has
> failed; it doesn't.
>
> Read `00` first for the Vertical concept and the cross-cutting contracts.

---

## The test

> "If I eventually wanted to support food ordering, it would be pretty trivial to
> add in those stores and implement a different type of tracking that is much
> faster and shows the courier in real time."

We hold the design to that sentence. Below: the additive checklist, then each
layer in detail, then the explicit "untouched" list.

---

## 0. The additive checklist

| # | Layer | What you add | Doc |
|---|---|---|---|
| 1 | Vertical registry | A `food` config entry (labels, catalog schema variant, strategy wiring) | 01 |
| 2 | Generation | A `FoodGenerationStrategy` (menu-item prompt + schema) | 02 |
| 3 | Domain / fulfillment | A `FoodFulfillmentStrategy` (fast state machine + timings) | 01 |
| 4 | Real-time tracking | A `FoodTrackingProvider` that emits geo + a `geoPlan()` route | 04 |
| 5 | Client | Register a `map` tracking renderer + (optional) food browse tweaks | 03 |
| 6 | Data | **Nothing** — JSONB attrs + per-vertical state strings already fit | 01 |
| 7 | Seed | Seed a few restaurants/menu items (or let generation fill on demand) | 02 |

Five small, isolated additions. No migrations, no API version bump, no edits to
cart/checkout/transport.

---

## 1. Register the vertical _(doc 01)_

Verticals live in a registry keyed by `verticalId`. Adding `food` is a config
entry that names its strategies and its catalog/display shape:

```ts
// verticals/food/index.ts
registerVertical({
  id: 'food',
  displayName: 'Food',
  catalogKind: 'menu_item',            // drives JSONB attribute validation
  generation: FoodGenerationStrategy,  // §2
  fulfillment: FoodFulfillmentStrategy,// §3
  tracking: FoodTrackingProvider,      // §4
  // display labels the CLIENT renders as data — no client enum changes
  order: {
    trackingMode: 'map',               // vs 'timeline' for retail
    capabilities: { liveLocation: true },
  },
});
```

The core platform never branches on `'food'`. It looks up the active vertical and
calls interface methods. That's the whole point — see `00` §6 principle 1.

---

## 2. Generation strategy: menu items, not products _(doc 02)_

Retail generates a *product*; food generates a *menu item* (and optionally a
*restaurant*). This is a different **prompt template + output schema**, selected
by the vertical — not a fork of the pipeline. The queue, dedup, image ingestion,
rate limiting, and persistence seam are all shared.

```ts
// verticals/food/generation.ts
export const FoodGenerationStrategy: GenerationStrategy = {
  schema: MenuItemListingSchema,        // title, description, ingredients,
                                        // dietary tags, price, image prompts
  buildPrompt: ({ canonicalQuery, context }) => foodListingPrompt(canonicalQuery),
  imagePromptStyle: 'appetizing food photography, overhead, soft light',
};
```

The signature feature still works: search "korean fried chicken" with no match →
the **same** search-miss → canonicalize → dedup → enqueue → Claude → image-model →
persist flow (doc 02), just with the food schema and prompt. Client sees the same
`pending → partial → ready` states.

---

## 3. Fulfillment strategy: a faster state machine _(doc 01)_

Retail's lifecycle is slow (`confirmed → packed → shipped → out-for-delivery →
delivered` over simulated days). Food is fast (`accepted → preparing → picked-up →
en-route → arriving → delivered` over minutes). Each is a `FulfillmentStrategy`
that the order service and simulation engine consume identically:

```ts
// verticals/food/fulfillment.ts
export const FoodFulfillmentStrategy: FulfillmentStrategy = {
  states: ['accepted','preparing','picked_up','en_route','arriving','delivered'],
  initial: 'accepted',
  // transition timings (simulated minutes, jittered)
  next(state) {
    switch (state) {
      case 'accepted':  return { to: 'preparing', afterMs: min(2) };
      case 'preparing': return { to: 'picked_up', afterMs: min(8) };
      case 'picked_up': return { to: 'en_route',  afterMs: min(1) };
      case 'en_route':  return { to: 'arriving',  afterMs: min(6) };
      case 'arriving':  return { to: 'delivered', afterMs: min(3) };
      default:          return null; // terminal
    }
  },
  // expose stages as display data for the vertical-agnostic client
  display: foodDisplayStages,
};
```

The order-placement endpoint, `Idempotency-Key` handling, the transactional
outbox, and the delayed-job simulation engine (BullMQ) are **unchanged** — they
operate on whatever strategy the vertical provides.

---

## 4. Tracking provider: turn on geo _(doc 04)_

This is the "shows the courier in real time" part. Retail's provider emits only
state changes. Food's provider **also** emits geo. The transport, channels,
`seq` ordering, and catch-up logic are all shared — geo is "just another
channel."

```ts
// verticals/food/tracking.ts
export const FoodTrackingProvider: TrackingProvider = {
  stateMachine: FoodFulfillmentStrategy,   // reuse §3
  emitsGeo: () => true,                     // retail returns false
  async geoPlan({ order }) {
    // pre-compute a plausible courier route once, interpolate server-side
    return osrmRoute(order.restaurantLoc, order.deliveryLoc); // precision-5 polyline
  },
  renderEvent(state) { /* state → displayState/progress/eta */ },
};
```

During the `en_route`/`arriving` states the simulation engine publishes
`geo_position` events at **1–2s** on the `order:{id}:geo` channel (doc 04 §4–5).
The client interpolates between points. Adding food = implement this provider +
the one `register()` line in §1; the engine and transport never learn the word
"food".

---

## 5. Client: register a map renderer _(doc 03)_

The client already renders lifecycle from server data (`display.stages`,
`trackingMode`, `capabilities` — contract `00` §4.1). The only genuinely new
client work is a **tracking renderer for `trackingMode: 'map'`**: a live map
(MapLibre/Mapbox/Apple Maps) that subscribes to the `:geo` channel and smoothly
moves a courier marker. This slots into the client's component registry:

```ts
// the registry already maps trackingMode -> renderer
trackingRenderers.register('timeline', ShippingTimeline);  // existing (retail)
trackingRenderers.register('map', LiveCourierMap);         // NEW (food)
```

Browse/cart screens may get food-flavored polish (menu layout, modifiers), but
the cart, checkout, search, and generation-skeleton UX are reused as-is. The app
picks the renderer from the order's `trackingMode` — no `if (food)` in screen
code.

---

## 6. Data layer: nothing to migrate _(doc 01)_

Because per-vertical attributes live in **Postgres JSONB** and order state is a
per-vertical string (not a global enum constrained in the schema), food needs
**no migration**:
- A menu item is a `listing` row with `catalogKind = 'menu_item'` and its
  food-specific fields in JSONB.
- A food order is an `order` row with `verticalId = 'food'` and its state in the
  same `state` column, validated by the food strategy rather than the DB.
- `pgvector` dedup works identically across verticals (embeddings are
  vertical-scoped by storefront).

---

## 7. What you do **not** touch

| Untouched | Why |
|---|---|
| Database schema / migrations | JSONB + per-vertical state strings already fit (§6) |
| API version (`/v1`) | Vertical additions are additive-by-default (doc 01); no breaking change |
| Cart & checkout | Vertical-agnostic; operate on listings + orders generically |
| Order-placement path | `Idempotency-Key`, outbox, queueing are shared |
| Generation queue/dedup/image ingestion | Only the prompt+schema strategy differs (§2) |
| Real-time transport (Ably/SSE, channels, `seq`, catch-up) | Geo is just a second channel (§4) |
| Client cart/search/skeleton UX | Reused; only a new tracking renderer is added (§5) |
| Auth/identity, infra topology | Wholly independent of vertical |

---

## 8. Effort estimate

For a developer who knows the codebase, the food vertical is roughly:
- **Config + 3 strategy classes** (generation, fulfillment, tracking): ~1–3 days
  of focused work, mostly prompt/schema design and tuning transition timings.
- **OSRM route plumbing** for geo (one-time infra, reused by all map verticals):
  ~1–2 days the first time, ~0 after.
- **One client `LiveCourierMap` renderer**: ~3–5 days for a polished, smoothly
  interpolated map experience.
- **Food browse/cart polish** (optional, for delight): open-ended.

The *platform* work (registry, generation pipeline, simulation engine, transport,
vertical-agnostic client) is paid once, up front, for retail — and that
investment is exactly what makes every subsequent vertical cheap. That is the
trade this architecture deliberately makes: a bit more structure now so that
"add food," "add grocery," "add ride-hailing-style tracking" are each a few
strategy classes, not a project.

---

## 9. Generalizing beyond food

The same five-step recipe adds any vertical. The two axes that vary are captured
by exactly two pluggable pieces:

| Axis | Pluggable piece | Examples |
|---|---|---|
| **What's in the catalog & how it's generated** | `GenerationStrategy` (prompt + schema) | products, menu items, services, tickets |
| **How an order progresses & is tracked** | `FulfillmentStrategy` + `TrackingProvider` (state machine, cadence, geo?) | slow shipping timeline, fast courier map, instant-digital, scheduled-appointment |

If a future vertical needs a genuinely new *capability* (e.g. multi-stop
batched delivery, or live chat with a provider), that's a new capability flag +
strategy method added to the interface — still additive, still behind the seam.
