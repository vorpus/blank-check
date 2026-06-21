# Stage 01 · 03 — Web Frontend (Web Client)

**Status:** Active — current build target · **Owner:** Web Client · **Date:** 2026-06-21
**Realizes:** architecture **03** (client) re-cut as *web-only, functional, no choreography*.
**Builds on:** [`README.md`](README.md) (Stage 1 charter — §2 topology, §3 tech, **§4 frozen contracts**, §6 acceptance demo).
**Consumes (siblings):** [`01-backend-api.md`](01-backend-api.md) (REST `/v1` + SSE we call), [`02-fake-generation.md`](02-fake-generation.md) (media states/events we render), [`05-contracts-and-sdk.md`](05-contracts-and-sdk.md) (the typed SDK + shared Zod/types — **we consume, never duplicate**).
**Defers to Stage 03:** all animation choreography, haptics, sound, streaming-token polish, blurhash artistry, staggered reveals, celebration moments.
**Defers to Stage 06/07:** native/mobile leaves and the escape-hatch policy (arch 03 §1); the `map` tracking renderer and live geo (food).

---

## 0. What this doc owns (and the Stage-1 boundary)

This doc owns the **`apps/web` Next.js (App Router) + React + TypeScript + Tailwind** application: the full retail loop — **search → results grid → listing detail → cart → checkout → order/tracking → order history** — rendering lifecycle **from server data**, with the SSE tracking client + polling fallback, the functional generation states, and anonymous identity.

> **The Stage-1 line in the sand.** Stage 1 ships **functional UI** — skeleton / placeholder / ready states with correct data plumbing and correct state transitions. It ships **no animation choreography**: no Reanimated/Framer-Motion timelines, no confetti, no haptics, no sound, no staggered cascade, no token-by-token typewriter polish, no blurhash shimmer art. Where arch 03 §4/§6 describes "cross-fade," "stagger," "celebration," "dopamine," Stage 1 implements the *functional skeleton of that state* (a plain CSS opacity transition at most) and **explicitly leaves the choreography to Stage 03**. Every place this matters is flagged **`[→S3]`** below.

A second purpose, per the charter goal: this stage is where we **"define the features and lock the core working set."** So §2 below is the canonical **feature inventory** for the product loop — every screen, what it shows, the data it needs, the actions it supports. Later stages add polish and platforms on top of *this* set, not a different one.

Because Stage 1 is web-only, we **do not** build the cross-platform `ui-native` leaves, the SDUI feature-module split, Style-Dictionary token emission, or EAS tooling from arch 03 §6–§8. We do honor the **two load-bearing ideas** from arch 03 that the acceptance demo checks: (1) **render lifecycle from `display.stages`**, and (2) a **tracking-renderer registry keyed on `trackingMode`**. Everything else from arch 03 is a Stage-3/6 concern.

---

## 1. App shape, stack, and repo position

Per charter §3, the web app is **Next.js (App Router) + React + TypeScript + Tailwind**, living at `apps/web` in the pnpm workspace (charter §3 "Monorepo"). It consumes `packages/contracts` (the typed SDK + shared Zod schemas + realtime event types — owned by [`05-contracts-and-sdk.md`](05-contracts-and-sdk.md)).

| Concern | Stage-1 choice | Notes |
|---|---|---|
| Framework | **Next.js App Router** | server-driven rendering, file-based routes (arch 03 §2.2) |
| Language | **TypeScript (strict)** | shared tsconfig from `tooling/` |
| Styling | **Tailwind** | utility classes; no design-token pipeline yet (`[→S3]`) |
| Data/cache | **TanStack Query v5** | query-key factory, optimistic cart (arch 03 §2.3–2.4) |
| Network SDK | **typed SDK from `packages/contracts`** | generated from the `/v1` OpenAPI spec; do not hand-roll fetch |
| Boundary validation | **Zod** (from `packages/contracts`) | parse every response, never trust the wire (charter §3, arch 03 §1.3) |
| Realtime | **native `EventSource`** (SSE) + polling fallback | `Last-Event-ID` replay (charter §4.3) |
| Rendering mode | mostly **client components** for the interactive loop; **RSC/SSR** for the shareable listing detail (SEO) | |

**Rendering-mode policy (Stage 1):**
- `listing/[id]` is server-rendered for shareable/SEO links (arch 03 §1, "first-class web, SEO/links to listings"). It hydrates into a client island for cart actions and the live media-state subscription.
- `browse`, `cart`, `checkout`, `order/[id]`, `orders` are primarily client components — they are interactive, auth-scoped, and realtime-driven, so SSR buys little. They render a server shell + skeleton, then fetch.
- All data goes through the **typed SDK**; no direct `fetch` in components.

---

## 2. Feature inventory — the core working set

This is the **"define the features" deliverable**. Seven screens make up the retail loop. For each: **shows / needs / actions**. Data shapes are the §4 contract payloads from `packages/contracts` — referenced, not redefined here.

> **Vertical-agnostic, always.** Every listing/order payload carries `verticalId`, `display.stages[]`, `display.trackingMode`, `capabilities` (charter §4.1). The UI **never** branches on `verticalId === 'retail'` and **never** hardcodes a state enum. Only `retail` is registered, but the code path is generic.

### 2.1 Home / Search — `/` (route group `(shop)`)
- **Shows:** a prominent search box; a default browse grid of seeded catalog listings (recent/popular) so a cold open is never empty; entry points to cart and order history.
- **Needs:** `GET /v1/search?q=` (empty/default query → seeded catalog page) → `SearchResult[]` (blended grid). Cart badge count from `useCart`.
- **Actions:** submit a search term → navigate to results; open a listing; open cart; open order history.

### 2.2 Results grid — `/search?q=…` (same screen, query-driven)
- **Shows:** the **blended cache-vs-generate grid** (charter §1, arch 02 §4.7 simplified). Cache hits render as full **listing cards** immediately; generated/missing slots render **skeleton cards** that fill in as the fake pipeline produces text then media. A query that's an exact re-search returns an **instant cache hit** (no skeletons) — the acceptance-demo "search the same term again" step.
- **Needs:** `GET /v1/search?q=…` → an ordered array of `SearchResult` entries. Each entry is either a ready `Listing` or a **placeholder** carrying `{ listing_id, generation_id, media.status }` so the card knows to subscribe (charter §4.2). Per-card media updates arrive via the **generation event keyed on `generation_id`** (charter §4.3).
- **Actions:** open a listing (a card is tappable as soon as it has a `listing_id`, even while `generating_media` — see §6); refine/re-search; scroll.

### 2.3 Listing detail — `/listing/[id]`
- **Shows:** title, description, specs/attributes, price, hero image (or placeholder while `generating_media`), and an **Add to cart** affordance. Server-rendered for shareability.
- **Needs:** `GET /v1/listings/{id}` → `Listing` (includes `verticalId`, `media`). If the listing is mid-generation, subscribes to the generation event on its `generation_id` to swap text→image in place.
- **Actions:** add to cart (quantity selectable); go to cart; back to results. **A listing is orderable while `media.status === 'generating_media'`** — Add-to-cart is enabled; only a truly absent listing blocks it. `degraded` is **not an error**: the listing is fully usable, it just shows the placeholder/last image (charter §4.2).

### 2.4 Cart — `/cart`
- **Shows:** line items (listing thumbnail, title, unit price, quantity, line total), order subtotal, and a **Checkout** button. One active cart per device (charter §1).
- **Needs:** `GET /v1/cart` → `Cart { items[], totals }`.
- **Actions:** change quantity (optimistic — see §9), remove an item (optimistic), proceed to checkout, continue shopping. Empty-cart state links back to search.

### 2.5 Checkout — `/checkout`
- **Shows:** an order summary (items + total) and a minimal **anonymous** checkout — **no login, no real payment** (charter §1, §6.3). A placeholder shipping/contact block (fake), and a **Place order** button.
- **Needs:** `GET /v1/cart` for the summary; the device bearer token (anonymous identity, §8).
- **Actions:** **Place order** → `POST /v1/orders` with an **`Idempotency-Key`** (charter §4 / arch 03 §2.4); on success, navigate to the order/tracking screen. Re-submitting with the same key must not double-create (idempotent place-order is an acceptance criterion).

### 2.6 Order / Tracking — `/order/[id]`
- **Shows:** the **live retail timeline**, rendered **entirely from `display.stages[]`** (charter §4.1, §6.5). Each stage shows `{ label, reached, current }`; the current stage is highlighted; reached stages are checked. Order summary (items, total) alongside. Connection/status affordance (live vs polling fallback — §7).
- **Needs:**
  - `GET /v1/orders/{id}` → `Order { verticalId, display: { stages[], trackingMode }, capabilities, items, totals, status }`.
  - SSE subscription to `order:{id}` for live `tracking_event`s (charter §4.3).
  - Snapshot/replay `GET /v1/orders/{id}/tracking` on (re)connect.
  - Polling `GET /v1/orders/{id}` as the always-available fallback.
- **Actions:** watch the timeline advance live to `delivered`; reload mid-flight and resync; the screen survives an SSE drop via polling. No user mutation of an in-flight order in Stage 1.

### 2.7 Order history — `/orders`
- **Shows:** a list of the device's past/active orders (most recent first): a per-order summary, current stage (from that order's `display.stages` current), and a link into its tracking screen.
- **Needs:** `GET /v1/orders` → `Order[]` (persisted, device-scoped). Active orders show their live current stage.
- **Actions:** open an order's tracking; re-enter the loop (search again).

> **Feature set, locked.** The seven screens above + their actions are the Stage-1 core working set. Stage 3 adds *feel* (animation/haptics/sound) to these exact surfaces; Stage 6 adds the native leaves; Stage 7 adds the `map` tracking renderer for food. None of them adds a *new core feature* — they re-skin or re-platform this set.

---

## 3. Route / page structure (App Router)

Routes are **generic and vertical-agnostic** (arch 03 §2.2): the path never names a vertical, and what renders inside is chosen by server data.

```
apps/web/
  app/
    layout.tsx                     # root: <Providers> (QueryClient, IdentityProvider), nav chrome, cart badge
    providers.tsx                  # 'use client' — QueryClientProvider + identity bootstrap
    (shop)/
      page.tsx                     # Home: search box + default seeded grid       (2.1)
      search/
        page.tsx                   # Results grid (reads ?q=)                       (2.2)
      listing/[id]/
        page.tsx                   # Listing detail — RSC/SSR shell                 (2.3)
        ListingClient.tsx          # 'use client' island: media subscription + add-to-cart
      cart/
        page.tsx                   # Cart                                           (2.4)
      checkout/
        page.tsx                   # Checkout + place order                         (2.5)
      order/[id]/
        page.tsx                   # Order / live tracking                          (2.6)
      orders/
        page.tsx                   # Order history                                  (2.7)
    loading.tsx                    # App Router segment skeletons (route transitions)
    error.tsx                      # boundary fallback (degraded ≠ error; see §6)
  components/
    listing/ ListingCard.tsx       # DATA-DRIVEN card (skeleton → text → media)     (§5, §6)
    listing/ SkeletonCard.tsx
    cart/    CartLineItem.tsx
    tracking/ TrackingRenderer.tsx # registry dispatcher keyed on trackingMode      (§5)
    tracking/ TimelineRenderer.tsx # the ONLY registered renderer in Stage 1
    common/  ... (Price, QtyStepper, ConnectionBadge, MediaImage)
  lib/
    sdk.ts                         # typed SDK instance from packages/contracts
    queryKeys.ts                   # qk factory (§9)
    identity.ts                    # deviceId bootstrap + bearer (§8)
    realtime.ts                    # SSE EventSource wrapper + seq dedup (§7)
  hooks/
    useSearch.ts  useListing.ts  useCart.ts  useOrder.ts  useTracking.ts  useGenerationMedia.ts
```

**Component tree (representative — order/tracking screen):**

```
<OrderPage params={id}>
  └ useOrder(id)            → Order (display.stages, trackingMode, capabilities)
  └ useTracking(id)         → applies SSE/poll events into the Order cache
  └ <OrderSummary items totals/>
  └ <TrackingRenderer trackingMode=display.trackingMode order=order/>   ← registry dispatch
        └ (trackingMode==='timeline') <TimelineRenderer stages=display.stages/>
        └ (trackingMode==='map')      <MapRenderer/>   ← SLOT RESERVED, not registered (Stage 7)
  └ <ConnectionBadge mode={'live' | 'polling'}/>
```

---

## 4. Data-fetching layer — TanStack Query + the typed SDK

All network access goes through the **typed SDK exported by `packages/contracts`** (charter §3 "SDK", arch 03 §1, §7.2). Components never call `fetch` directly; hooks call the SDK, and the SDK applies the **Zod schemas** from `packages/contracts` at the boundary (§10).

- **One `QueryClient`** in `providers.tsx`. `staleTime` is generous for immutable `ready` listings, short and aggressive for cart/order (arch 03 §2.3).
- **Query-key factory** `qk` in `lib/queryKeys.ts` — single source of invalidation truth (§9).
- The SDK instance (`lib/sdk.ts`) is configured with the **base URL** (`/v1` on `api:8080`) and an **auth hook** that injects the device bearer token from `lib/identity.ts` (§8) on every request, plus the `X-Device-Id` bootstrap header.

**Hooks (arch 03 §2.1 layering — the feature-hooks layer):**

| Hook | Wraps | Returns |
|---|---|---|
| `useSearch(q)` | `GET /v1/search` | blended `SearchResult[]`; seeds the cache with placeholders so cards can self-subscribe (§6) |
| `useListing(id)` | `GET /v1/listings/{id}` | `Listing` |
| `useCart()` | `GET /v1/cart` + mutations | `Cart` + `addItem/setQty/removeItem` (optimistic, §9) |
| `useOrder(id)` | `GET /v1/orders/{id}` | `Order` (the polling fallback also writes here) |
| `useTracking(id)` | SSE `order:{id}` + snapshot/replay + poll | merges events into `qk.order(id)` cache; exposes `{ mode }` |
| `useGenerationMedia(generationId)` | generation event | media-state patches `generating_text → generating_media → ready/degraded` |

> **One data path.** Both tracking events and generation media-swaps land in the TanStack Query cache via `queryClient.setQueryData(...)` (arch 03 §2.6, §4.3). Components subscribe through the normal hooks; realtime is not a special-case render path.

---

## 5. Data-driven rendering — no hardcoded state enum

This is the contract the acceptance demo verifies (charter §6.5): **the client has no retail state enum.** Two surfaces prove it.

### 5.1 The listing card renders from server data
`ListingCard` takes a `SearchResult`/`Listing` and renders from its fields and `media.status`. It does **not** know what a "ladder" is, does not branch on `verticalId`, and reads its image/placeholder decision from `media` (§6). The skeleton-vs-content decision is data-driven, not query-driven.

### 5.2 The tracking timeline renders from `display.stages[]`
`TimelineRenderer` maps over `order.display.stages[]` and renders each `{ key, label, reached, current }`. **There is no `const RETAIL_STAGES = [...]` anywhere in the web app.** Add a stage server-side and the UI shows it with zero client change. Grep target for review: no enum of order states in `apps/web`.

### 5.3 The `TrackingRenderer` registry (keyed on `trackingMode`)
Per charter §4.1, the order payload carries `display.trackingMode`. The client owns a **registry** (the Stage-1, web-only, bounded form of arch 03 §3/§5's renderer registry) keyed on that mode:

```ts
// components/tracking/registry.ts
type TrackingRendererFn = (props: { order: Order }) => JSX.Element;

const trackingRegistry = new Map<string, TrackingRendererFn>();
export const registerTracking = (mode: string, r: TrackingRendererFn) =>
  trackingRegistry.set(mode, r);

// Stage 1: ONLY 'timeline' is registered.
registerTracking('timeline', TimelineRenderer);
// 'map' slot is RESERVED for Stage 7 (food/live-location) — intentionally NOT registered now.

export function TrackingRenderer({ order }: { order: Order }) {
  const r = trackingRegistry.get(order.display.trackingMode);
  if (!r) return <UnsupportedTracking mode={order.display.trackingMode} />; // forward-compat, never crash
  return r({ order });
}
```

- **Map vs timeline is chosen by data.** `display.trackingMode` selects the renderer; `capabilities.liveLocation` (`false` for retail — charter §4.1) is what a future `map` renderer would consult to open the geo channel. Stage 1 never opens a geo channel.
- **Unknown mode → graceful fallback**, never a crash (mirrors arch 03 §3.3 forward-compat). This is what keeps the `map` addition in Stage 7 purely additive: register one renderer, change nothing else.

---

## 6. The generation UX (functional — no choreography)

Search may return ready cache hits and **placeholders** that materialize via the fake pipeline (charter §1, §4.2; arch 02 media states; sibling [`02-fake-generation.md`](02-fake-generation.md)). Stage 1 implements the *states correctly* and the *feel later* (`[→S3]`).

### 6.1 Blended grid + skeletons on a miss
- `useSearch(q)` returns the blended array. **Ready** entries render full `ListingCard`s immediately. **Placeholder** entries (carrying `media.status` + `generation_id`) render `SkeletonCard`s that upgrade in place.
- On a **search miss**, the grid shows skeleton cards **instantly** (the "skeleton/placeholder grid appears instantly" acceptance step), then fills. An **exact re-search** returns all-ready entries → no skeletons (instant cache hit).

### 6.2 The three media states (subscribed on `generation_id`)
Per charter §4.2, `media.status ∈ { generating_text, generating_media, ready, degraded }`. The card subscribes to the **generation event keyed on `generation_id`** (`images.ready` / `images.degraded`, charter §4.3) via `useGenerationMedia`, and renders:

| `media.status` | Stage-1 functional render | Stage-3 polish `[→S3]` |
|---|---|---|
| `generating_text` | **text streams in — minimal: just append** the text as it arrives; render it immediately. Image area shows the placeholder box. | token-by-token typewriter, cursor, easing |
| `generating_media` | **placeholder image** (blurhash-decoded still or solid box) **+ a plain "loading" indicator** (e.g. the word "loading" / a static spinner). Card is **fully interactive and orderable**. | animated shimmer, generative flourish |
| `ready` | **final image** swapped in. | — |
| `degraded` | **not an error** — render the placeholder/last image and treat the listing as fully usable/orderable. | gentle "couldn't summon art" tile |

- **Render text immediately.** Don't wait for media — title/desc/price show as soon as they arrive.
- **Image swap:** `blurhash placeholder → resolved image`. A **functional CSS cross-fade (opacity transition) is fine**; the *choreographed* cross-fade/stagger is **Stage 3**. Reserve the aspect-ratio box up front so there's **no layout shift** (this is a correctness concern, not polish, so it ships now).
- **Orderable while generating.** A listing in `generating_media` is tappable and **Add-to-cart works** (§2.3). Only an absent listing blocks.

### 6.3 Data plumbing
- `useSearch` seeds the query cache with placeholder entries.
- `useGenerationMedia(generation_id)` patches each card via `setQueryData` as `generating_text → generating_media → ready/degraded` — the **same `setQueryData` path** tracking uses (§4, arch 03 §4.3). One subscription mechanism, two payload kinds.
- Subscription lifecycle (subscribe on mount, drop on unmount) lives in the hook, not the component.

---

## 7. The SSE tracking client + polling fallback

Implements charter **§4.3** exactly. Lives in `lib/realtime.ts` + `hooks/useTracking.ts`.

### 7.1 Subscribe + ordered apply
- On the tracking screen, subscribe to channel **`order:{id}`** via `EventSource` (SSE). Generation swaps ride the **same fan-out** keyed on `generation_id` (charter §4.3) — the realtime client demultiplexes by event payload.
- Every event carries a per-order **monotonic `seq`** and server `ts`. Client rules (charter §4.3 / arch 00 §4.3):
  - **Apply in `seq` order.**
  - **Drop `seq <= lastApplied`** (idempotent).
  - Trust server `ts` over the local clock.
  - Each applied `tracking_event` updates `display.stages` in the `qk.order(id)` cache via `setQueryData`.

### 7.2 Snapshot + replay on (re)connect
- On first subscribe and on **every reconnect**, call **`GET /v1/orders/{id}/tracking`** to get a snapshot + the latest `seq`, seed `lastApplied`, then replay live events from `seq` so **no milestone is lost**. SSE `Last-Event-ID` is set from `lastApplied` so the server can replay from the cursor.
- Reload mid-flight ⇒ fresh snapshot ⇒ the timeline **resyncs** (acceptance step 4).

### 7.3 Polling fallback (always available)
- If SSE fails to open, errors, or stays disconnected past a short backoff, switch to **polling `GET /v1/orders/{id}`** on an interval. This is the always-available fallback (charter §4.3); the order payload itself carries current `display.stages`, so polling keeps the timeline current with **no special path**.
- `useTracking` exposes `{ mode: 'live' | 'polling' }`; `ConnectionBadge` reflects it. Killing the SSE connection ⇒ polling keeps it current (acceptance step 4) ⇒ on SSE recovery, re-snapshot and resume live.

### 7.4 The hooks
- `useTracking(id)` — owns the EventSource lifecycle, `seq` dedup, snapshot/replay, and the polling fallback; writes into `qk.order(id)`.
- `useOrder(id)` — reads the order; its query function is `GET /v1/orders/{id}`, which is *also* what the polling fallback calls (so live and polling converge on one cache entry).

---

## 8. Anonymous identity (charter §4.4)

No login, no passwords, no email (charter §1). The client bootstraps a device identity and carries a bearer token.

- **Bootstrap (`lib/identity.ts`):** on first load, read a persisted `deviceId` from `localStorage`; if absent, call **`POST /v1/identity/device`** (or send the **`X-Device-Id`** bootstrap header) to issue/look up the anonymous `user` keyed on `deviceId`, and receive a **short-lived bearer token**.
- **Wiring:** `IdentityProvider` (in `providers.tsx`) runs the bootstrap before authed queries fire; the SDK's auth hook injects `Authorization: Bearer <token>` + `X-Device-Id` on every request (§4).
- **Refresh:** on a 401, re-bootstrap (re-issue the token for the same `deviceId`) and retry once.
- **Forward-compat:** this is the **same bearer scheme** Stage 04 will issue real accounts under (charter §4.4) — account upgrade is "swap the token issuer," so the client auth plumbing does **not** change. Stage 1 ships only the anonymous issuer path.

---

## 9. State management — TanStack Query keys + optimistic cart

### 9.1 Query-key factory (`lib/queryKeys.ts`)
Single source of truth for invalidation (arch 03 §2.3):

```ts
export const qk = {
  search:  (q: string)  => ['search', q] as const,
  listing: (id: string) => ['listing', id] as const,
  cart:    ()           => ['cart'] as const,
  order:   (id: string) => ['order', id] as const,
  orders:  ()           => ['orders'] as const,
};
```

### 9.2 Optimistic cart updates (arch 03 §2.4)
Add / set-quantity / remove use the `onMutate → onError → onSettled` pattern:
- `onMutate`: snapshot `qk.cart()`, apply the optimistic line-item/total change.
- `onError`: roll back to the snapshot.
- `onSettled`: invalidate `qk.cart()` to reconcile with the server.

Functional only in Stage 1 — the cart updates instantly; the **fly-to-cart animation, badge bounce, haptic, and sound are Stage 03** `[→S3]` (arch 03 §2.4, §6.4).

### 9.3 Place order (idempotent)
`POST /v1/orders` carries a per-placement **`Idempotency-Key`** (arch 03 §2.4, charter §4) so retries don't double-create. On success, invalidate `qk.cart()` and `qk.orders()`, and navigate to `/order/{id}`. The **celebration moment is Stage 03** `[→S3]`; Stage 1 just transitions to the tracking screen.

### 9.4 Persistence (light)
Browse/cart survive a reload via the TanStack persisted cache where trivial; the **paused/persisted mutation queue and full offline outbox** (arch 03 §2.5) are **out of scope for Stage 1** — search-that-generates is online-only anyway.

---

## 10. Zod validation at the network boundary

Per charter §3 ("Validation: Zod at every boundary") and arch 03 §1.3 ("parse network responses, never trust them"):

- The **Zod schemas live in `packages/contracts`** (owned by [`05-contracts-and-sdk.md`](05-contracts-and-sdk.md)). The web app **imports and applies them — it does not define or duplicate them.**
- The typed SDK parses every response with the matching schema **before** it reaches a hook/component. A parse failure is a boundary error (surfaced to an error boundary / telemetry), never silently rendered.
- SSE event payloads (`tracking_event`, `images.ready`/`images.degraded`) are parsed with their realtime-event schemas from `packages/contracts` before being applied to the cache.
- This is what makes "render from server data" safe: by the time `display.stages[]` reaches `TimelineRenderer`, it's validated.

---

## 11. Explicit Stage-3 / later deferrals

To keep the boundary unambiguous, Stage 1 **does not** build:

- **Animation choreography** — Reanimated/Framer-Motion timelines, staggered card cascades, animated layout reflow, the place-order celebration/confetti (arch 03 §4.2, §6.2, §6.4) → **Stage 03**.
- **Haptics & sound** — `expo-haptics`, audio cues, feedback intents (arch 03 §6.3) → **Stage 03** (and mobile-only).
- **Streaming-token polish & blurhash artistry** — typewriter reveal, shimmer skeletons (arch 03 §4.2). Stage 1 appends text plainly and uses a static placeholder (charter §1 out-of-scope) → **Stage 03**.
- **Design-token pipeline** — Style Dictionary, motion/haptic tokens (arch 03 §6.1) → **Stage 03**.
- **Native leaves & escape hatches** — RN/Expo, SwiftUI hero views, `ui-native` (arch 03 §1, §6.2) → **Stage 06**.
- **The `map` tracking renderer + live geo** — `tracking.liveCourierMap`, MapLibre, geo channel (arch 03 §5) → **Stage 07** (slot reserved, §5.3).
- **Full offline-first** — persisted mutation queue/outbox (arch 03 §2.5) → later.

---

## 12. Exit checklist (mapped to charter §6 acceptance demo)

Stage-1 web is **done** when, against `localhost` after `make up && make seed`:

| # | Acceptance demo (charter §6) | Web deliverable |
|---|---|---|
| 1 | **Browse** the seeded catalog and open a listing detail | Home renders the seeded grid; `ListingCard` → `/listing/[id]` (RSC/SSR) renders title/desc/specs/price/image. |
| 2a | Search a **brand-new term** → **skeleton/placeholder grid instantly** | `useSearch` seeds placeholders; `SkeletonCard`s render immediately on a miss. |
| 2b | Watch placeholder listings + images **materialize** | Cards subscribe on `generation_id`; render `generating_text` (append text) → `generating_media` (placeholder + "loading") → `ready` (final image), with no layout shift. `degraded` renders as usable, not an error. |
| 2c | Re-search the same term → **instant cache hit** | All-ready blended result → no skeletons. |
| 3 | **Add to cart**, adjust quantity, **check out** anonymously (no login) | Optimistic `useCart`; `/cart` qty/remove; `/checkout` places the order with only a device identity (§8). |
| 4a | **Place order** (idempotent) and watch the **timeline advance live via SSE** to `delivered` | `POST /v1/orders` + `Idempotency-Key`; `useTracking` applies `order:{id}` events in `seq` order; `TimelineRenderer` advances to `delivered`. |
| 4b | Reload mid-flight → tracking **resyncs** from snapshot+replay | `GET /v1/orders/{id}/tracking` snapshot seeds `lastApplied`; replay from `seq`. |
| 4c | Kill SSE → **polling fallback** keeps it current | `useTracking` falls back to `GET /v1/orders/{id}`; `ConnectionBadge` shows `polling`. |
| 5 | Every stage shown comes **from `display.stages`** — no retail state enum | `TimelineRenderer` maps `display.stages[]`; `TrackingRenderer` keyed on `trackingMode`; **grep proves no order-state enum in `apps/web`**. |
| — | Order **history** persists and is device-scoped | `/orders` lists device orders with current stage. |
| — | Runs with **zero real external API keys** | Web calls only local `api:8080`; no Anthropic/cloud creds. |

Plus: no `fetch` outside the SDK; Zod parse at every boundary; no `verticalId` branching in components; the `map` slot reserved but unregistered.
