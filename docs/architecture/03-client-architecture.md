# 03 — Client Architecture (Web + iOS + Android)

**Status:** Proposed · **Owner:** Client/Mobile Architecture · **Date:** 2026-06-20
**Scope:** Cross-platform strategy, app architecture & state, server-driven/vertical-driven rendering, generation UX, real-time tracking, design system & "dopamine" polish, repo structure, tooling.
**Out of scope:** Backend transport/schema (sibling doc), AI pipeline internals, infra.

> TL;DR recommendation: **Expo + React Native (New Architecture) for iOS/Android + React for web, in a single TypeScript monorepo, with a server-driven "vertical module" rendering layer and a pluggable tracking-renderer registry.** Reach for native SwiftUI/Kotlin **surgically** (via Nitro/Fabric host views) only on the few screens where premium feel demands it. This maximizes code sharing and velocity for a small team + outside contributors while keeping a path to native polish and a clean additive-vertical extensibility story.

---

## 0. Constraints & how they drive the decision

| Constraint | Weight | Implication |
|---|---|---|
| Premium, **native-feeling iOS** experience | High | Need real native components/gestures/haptics, not a uniform-rendered canvas. Need an escape hatch to SwiftUI for hero screens. |
| **Web** app required (first-class, SEO/links to listings) | High | Must run real DOM/CSS; RN-Web is "good", true web is "great". |
| **Small team + outside contributors** | High | Favor a *single* language/skillset (TypeScript/React). Low onboarding cost. Large hiring pool. |
| **Android later** | Medium | Don't pay Android cost now, but don't pick a stack that bolts it on painfully. |
| **Additive verticals** (retail → food) without rewrite | Critical | Server-driven UI + a component/feature-module registry. Verticals are data + a small renderer bundle, not a fork. |
| Highly animated "dopamine" feel | High | Need 120fps UI-thread animations, haptics, sound, gesture choreography. |
| Async AI generation UX | High | First-class skeleton → partial → ready streaming states. |
| Real-time tracking, two very different shapes | High | Pluggable tracking renderers + resilient streaming transport. |

These weights are why we do **not** pick "max nativeness everywhere" (too slow for a small team across 3 platforms) nor "max uniformity" (Flutter's rendered UI fights the premium-iOS goal and a weak web story). We pick the option that is *mostly shared TypeScript* with *targeted native escape hatches*.

---

## 1. Cross-platform strategy — the central decision

### 1.1 Options evaluated

| Option | iOS feel | Web quality | Code sharing | Team fit (TS/React, small + external) | Android-later cost | Vertical extensibility | Dopamine/animation | Verdict |
|---|---|---|---|---|---|---|---|---|
| **A. React web + native SwiftUI + native Android** | Best | Best | Low (only API client/models/tokens) | Poor — 3 skillsets, 3x UI work | High (full 3rd app) | 3x the registry work | Per-platform, excellent but 3x effort | Rejected (velocity) |
| **B. Expo/React Native (iOS+Android) + React web** ✅ | Very good (native widgets; SwiftUI escape hatch) | Very good (real React DOM on web; shared logic, platform-specific UI leaves) | **High** (logic, data, registry, tokens; UI mostly shared) | **Best** — one language, huge React talent pool | **Low** (Android is mostly free once RN is in) | **One** registry serves all | Excellent (Reanimated/Skia/Gesture Handler/Moti) | **Recommended** |
| **C. Flutter (iOS+Android+web)** | Good but *rendered* (not native widgets); Cupertino is an imitation | Web is canvas/HTML renderer — heavy, poor SEO, accessibility caveats | High within Flutter, **zero** with any React/web team | Poor for *our* team (Dart, smaller external pool) | Low | One registry (Dart) | Excellent rendering engine | Rejected (iOS "feel" + web + team) |
| **D. Kotlin Multiplatform / Compose MP** | iOS via Compose-iOS is rendered (Skia), still maturing; or share logic only + SwiftUI | Compose-web is experimental | High for logic; UI sharing to iOS less mature | Poor (Kotlin skillset, small external pool) | Native-strength | One registry (Kotlin) | Good | Rejected (iOS UI maturity + team) |

### 1.2 Recommendation — **Option B**, with a "native-when-it-matters" policy

> **Expo + React Native on the New Architecture (Fabric/Bridgeless) for iOS & Android, React (Next.js/Vite) for web, one TypeScript monorepo.** Use **react-native-web** sparingly and prefer platform-specific UI leaves over a forced single component. Drop to **SwiftUI (and later Compose)** via Fabric/Nitro host views on a *short, governed list* of hero surfaces.

**Why this wins for us (2026):**

- **One language, one mental model, huge talent pool.** Outside contributors and a small core team can be productive in TypeScript/React across all three targets. This is the dominant velocity lever and it is decisive given the team shape.
- **RN gives *real* native widgets, gestures, and haptics** — the premium-iOS bar is reachable without rendering our own UI (the Flutter trade-off). RN renders platform-native components, so iOS feels iOS.
- **New Architecture is the default and production-grade in current Expo SDKs** (Fabric/Bridgeless on by default since SDK 53; the majority of EAS builds already run it). Synchronous JSI access, concurrent React, and better native interop reduce the historic "RN bridge" tax. ([Expo SDK 53 changelog](https://expo.dev/changelog/sdk-53), [Expo New Architecture guide](https://docs.expo.dev/guides/new-architecture/))
- **Web is real React** (DOM/CSS, SSR/SEO for shareable listing pages) — not a canvas. We share *logic, data, registry, design tokens, and most component contracts*; only the leaf rendering differs where platform idioms diverge.
- **Android is nearly free later** — turning it on is mostly QA + platform-leaf tuning, not a third codebase.
- **Escape hatch is real and cheap now.** We can embed SwiftUI views in RN via Fabric native components or **Nitro Modules** (JSI bridge, zero-serialization) for the rare screens where we want Apple-grade fluidity (e.g. the order-placed celebration, the live courier map). ([Callstack: exposing SwiftUI to RN](https://www.callstack.com/blog/exposing-swiftui-views-to-react-native-an-integration-guide))

**Trade-offs we accept (and mitigations):**

| Trade-off | Mitigation |
|---|---|
| RN-Web is not a perfect web framework; some components feel "mobile-ported" | Keep web's *leaf* components web-native (Next.js + Tailwind/vanilla-extract). Share hooks/state/registry, not pixels. "Share behavior, fork presentation." |
| Native escape hatches add per-platform code | **Govern** them: a written allowlist of hero surfaces; each native view must implement a documented props contract so the JS side stays the source of truth. |
| New Arch native-module ecosystem still maturing in spots | Pin Expo SDK; vet third-party native deps for New-Arch support during selection; prefer Expo-maintained or Nitro modules. |
| Outside contributors touching native code | Keep native surfaces tiny and behind clear interfaces; 95% of contributions are pure TS. |

### 1.3 What is shared **regardless of platform** (the non-negotiable core)

These live in shared packages and are identical across web/iOS/Android:

- **API client** — transport-agnostic (see §2 and `04-backend` sibling). A thin `ApiClient` interface with REST or GraphQL implementations behind it; codegen'd types (§7).
- **Domain models & validation** — generated types + **Zod** schemas at every boundary (parse network responses, never trust them).
- **Design tokens** — colors, spacing, typography, motion curves, haptic/sound "intents" (see §6), authored once (Style Dictionary) and emitted per-platform.
- **State & data hooks** — TanStack Query keys, mutation logic, optimistic recipes, subscription handling (§2).
- **The vertical/component registry & SDUI schema** (§3) — the heart of extensibility.
- **Feature logic** — cart math, order state machines, formatting, analytics events.

Platform leaves (what's *not* shared): pixel-level layout, navigation chrome, the native escape-hatch views, and platform animation primitives — all hidden behind shared interfaces.

---

## 2. App architecture & state management

### 2.1 Layering

```
┌──────────────────────────────────────────────────────────────┐
│ Presentation (platform leaves)                                │
│   RN screens / React web pages · native SwiftUI hero views    │
├──────────────────────────────────────────────────────────────┤
│ Vertical Renderer Layer  (SDUI registry, §3)                  │
│   resolves backend config → component tree per vertical       │
├──────────────────────────────────────────────────────────────┤
│ Feature Hooks   (useSearch, useListing, useCart, useOrder,    │
│                  useTracking) — TanStack Query + state machines│
├──────────────────────────────────────────────────────────────┤
│ Data Layer                                                    │
│   TanStack Query cache · mutation queue · realtime client     │
│   ApiClient (REST/GraphQL impl) · Zod boundary validation     │
├──────────────────────────────────────────────────────────────┤
│ Platform Adapters  (storage, haptics, sound, maps, sockets)   │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Navigation

- **Mobile:** **Expo Router** (file-based, typed routes, deep-linkable) — maps cleanly to share-links for listings/orders and gives us native stack/tab transitions. Layouts and loading states are first-class, which we lean on for skeletons (§4).
- **Web:** **Next.js App Router** (or Expo Router for web if we want maximal route sharing — viable but we prefer Next.js for SSR/SEO on listing pages). Route *names and params* are shared via a typed route map so deep links are isomorphic.
- **Vertical-aware routes:** routes are generic (`/browse`, `/listing/[id]`, `/cart`, `/order/[id]`). What renders inside is chosen by vertical config (§3), so adding FOOD adds *no new routes*.

### 2.3 Data fetching & caching — **TanStack Query v5**

Chosen over Apollo/SWR because it is **transport-agnostic** (works identically over REST or GraphQL via our `ApiClient`), has the best optimistic-update + offline + mutation-pausing story, and runs identically on web and RN. (If backend lands on GraphQL we still wrap it in `ApiClient` + codegen documents rather than coupling UI to Apollo's normalized cache, preserving transport-agnosticism.)

Key conventions:
- **Query key factory** per domain: `qk.listing(id)`, `qk.search(params)`, `qk.cart()`, `qk.order(id)`. Shared package; one source of truth for invalidation.
- **Persistence:** `persistQueryClient` with an async-storage persister (MMKV on RN, IndexedDB/localStorage on web) so browse/cart survive cold start and brief offline.
- **Staleness:** listings are `staleTime`-generous (immutable once `ready`); cart/order are short and revalidate aggressively.

### 2.4 Optimistic updates (the dopamine-critical paths)

Pattern: `onMutate` snapshots cache → applies optimistic state → `onError` rolls back → `onSettled` invalidates. ([TanStack optimistic-updates docs](https://tanstack.com/query/v5/docs/react/guides/optimistic-updates))

- **Add to cart:** instant cache mutation; the satisfying animation + haptic fires on the optimistic state, not on server ack. Rollback animates the item back out on failure.
- **Place order:** optimistic transition to a local `order: { status: "placing" }`, drive the celebration immediately, reconcile with server `orderId`/status on settle. Use an **idempotency key** per placement so retries don't double-create.
- **Mutation queue + pausing:** with `retry` + network detection, mutations pause offline and **resume on reconnect**; persisted mutations survive app kill and hydrate later. This gives "place order on the subway" tolerance. ([TanStack offline discussion](https://github.com/TanStack/query/discussions/2597))

### 2.5 Offline tolerance (graceful, not full offline-first)

- Browse last-seen listings, cart, and order history from the persisted cache.
- Search requiring AI generation is **explicitly online-only** with a clear offline affordance (it can't generate offline).
- A small **outbox** (cart ops, order placement) backed by the persisted mutation queue.

### 2.6 Real-time subscription handling (overview; renderers in §5)

- A single **`RealtimeClient`** platform adapter abstracts SSE/WebSocket (see §5 transport choice).
- Tracking updates are merged into the TanStack Query cache via `queryClient.setQueryData(qk.order(id), …)`, so UI subscribes through the same `useOrder`/`useTracking` hooks — **no special-case data path**.
- Connection lifecycle (subscribe on screen focus, backoff on drop, resume via `Last-Event-ID`/cursor) lives in the adapter, not in components.

---

## 3. Server-driven UI / vertical-driven rendering (the extensibility core)

**Goal:** Add a new vertical (FOOD) as *additive modules + backend config*, never a rewrite. The backend declares *what* a vertical's browse/cart/track UI is made of; the client owns a **registry** of how to render each declared component type.

This is a deliberately **bounded SDUI**: the server selects and configures from a *versioned catalog of client-known components* — it does not ship arbitrary layout logic. This keeps us on the right side of app-store rules (no remote code execution) and keeps rendering native and fast. ([SDUI architecture guide](https://www.weweb.io/blog/server-driven-ui-guide-architecture-examples), Yelp CHAOS-style unified SDUI.)

### 3.1 Concepts

- **Vertical** — `retail`, `food`, … Backend returns a **VerticalConfig** that maps experience slots to component descriptors.
- **Slot** — a named extension point: `browse`, `listingDetail`, `cart`, `tracking`.
- **Component descriptor** — `{ type, version, props }` where `type` is a key into the client **component registry**.
- **Component registry** — `Map<type, Renderer>` per platform leaf. Same descriptors, platform-appropriate renderers.
- **Feature module** — a self-contained bundle that registers renderers for one vertical (+ its hooks, tokens, analytics). Adding FOOD = adding one feature module + backend config.

### 3.2 The contract (illustrative)

```ts
// shared/sdui/schema.ts  (codegen'd from backend schema; Zod-validated at runtime)
export type VerticalConfig = {
  vertical: "retail" | "food" | string;        // open string → forward-compatible
  schemaVersion: number;
  slots: {
    browse:        ComponentDescriptor;
    listingDetail: ComponentDescriptor;
    cart:          ComponentDescriptor;
    tracking:      ComponentDescriptor;          // selects timeline vs map (§5)
  };
  capabilities?: { liveCourier?: boolean; reorder?: boolean };
};

export type ComponentDescriptor = {
  type: string;                                  // registry key, e.g. "tracking.shippingTimeline"
  version: number;                               // components are versioned like an API
  props?: Record<string, unknown>;               // validated by the renderer's Zod schema
};
```

```ts
// shared/sdui/registry.ts
type Renderer<P = any> = {
  schema: ZodType<P>;                            // validate descriptor.props
  Component: React.ComponentType<P & SlotContext>;
  minSchemaVersion?: number;
};

const registry = new Map<string, Renderer>();
export const register = (type: string, r: Renderer) => registry.set(type, r);

export function SlotRenderer({ descriptor, ctx }: { descriptor: ComponentDescriptor; ctx: SlotContext }) {
  const r = registry.get(descriptor.type);
  if (!r) return <UnknownSlotFallback type={descriptor.type} />;   // forward-compat: never crash
  const parsed = r.schema.safeParse(descriptor.props ?? {});
  if (!parsed.success) return <SlotErrorFallback />;               // observable, non-fatal
  const Cmp = r.Component;
  return <Cmp {...parsed.data} {...ctx} />;
}
```

```ts
// verticals/retail/index.ts  — a feature module
register("browse.grid",               { schema: GridProps,     Component: RetailGrid });
register("cart.standard",             { schema: CartProps,     Component: StandardCart });
register("tracking.shippingTimeline", { schema: TimelineProps, Component: ShippingTimeline });

// verticals/food/index.ts  — ADDITIVE: shipping later, no edits to retail or core
register("browse.foodMenu",           { schema: MenuProps,     Component: FoodMenu });
register("cart.foodCart",             { schema: FoodCartProps, Component: FoodCart });
register("tracking.liveCourierMap",   { schema: MapProps,      Component: LiveCourierMap });
```

The generic screen never knows about verticals:

```tsx
function BrowseScreen() {
  const { data: cfg } = useVerticalConfig();        // backend-provided
  return <SlotRenderer descriptor={cfg.slots.browse} ctx={browseCtx} />;
}
```

### 3.3 Why this is safe & additive

- **Forward compatibility:** unknown `type`/`version` → graceful fallback (skeleton/placeholder + telemetry), never a crash. Old clients keep working when backend ships a new vertical; they just can't render its new components until updated (delivered via OTA, §8).
- **Versioning:** descriptors carry `version`; renderers declare the range they support. Backend can run experiments/rollouts per version. (Component-as-versioned-API is the 2026 SDUI norm.)
- **No remote code:** server picks from a *known catalog* and supplies props/config only. App-store-compliant, native-fast.
- **One registry, all platforms:** the descriptor contract is shared; each platform supplies leaf renderers. Adding FOOD touches *one feature module* + config, satisfying the critical extensibility requirement.

---

## 4. The generation UX (search → async AI materialization)

Search may return a **placeholder** while the AI generates the listing. The UX must make the wait feel like anticipation, not lag.

### 4.1 Client-side state contract with the AI pipeline

A listing (or search result) progresses through an explicit lifecycle the client subscribes to:

```ts
type ListingState =
  | { status: "pending";  id: string; placeholder: Skeleton }              // queued/generating
  | { status: "partial";  id: string; fields: PartialListing; }            // text in, images pending
  | { status: "ready";    id: string; listing: Listing; }                  // fully materialized
  | { status: "failed";   id: string; reason: string; retryable: boolean };// generation failed
```

**Contract we need from the AI pipeline / backend** (see summary):
1. Search returns *immediately* with stable `id`s and `status: "pending"` placeholders (count + rough shape so we can lay out skeletons).
2. A **stream** (per-search or per-listing) emits `partial` (incremental fields — title/price/desc first, images later via URLs that may still be 202/"generating") and `ready` transitions, each tagged with the listing `id`.
3. Each field/image carries a state so we can render *partial* content and lazy-fill the rest. Image URLs should be resolvable with their own `pending → ready` signal (or a poll/`<img>` retry contract).
4. `failed` carries `retryable` + reason; client offers retry or quietly drops with telemetry.
5. Idempotent, replayable from a cursor so reconnection (§2.6/§5) resumes mid-generation.

### 4.2 UX mechanics (perceived performance)

- **Skeletons first, instantly.** On search submit, render the grid of shimmer skeletons immediately from the `pending` count. (Reanimated/Skia shimmer; respects reduced-motion.)
- **Stream content in.** As `partial` arrives, **cross-fade** text into place (title → price → description). The card "fills" progressively — this *is* the dopamine.
- **Progressive image loading.** Show a **BlurHash/ThumbHash** placeholder (sent in `partial`) → fade to full image when the generated asset resolves. Use `expo-image` (built-in blurhash, caching, transition). Never layout-shift: reserve aspect-ratio boxes up front.
- **Stagger reveals.** Cards animate in with a small stagger so a batch "cascades" rather than popping — feels alive.
- **Optimistic anticipation copy.** Micro-copy ("conjuring listings…") + a subtle generative animation while pending.
- **Failure is gentle.** A failed card flips to a "couldn't summon this one" tile with a one-tap retry; the grid reflows smoothly (animated layout).
- **Don't block the screen.** Ready cards are interactive immediately (tap → detail) even while siblings still generate.

### 4.3 Data plumbing

- `useSearch` seeds the query cache with `pending` placeholders; the realtime/stream client patches each listing via `setQueryData(qk.listing(id), …)` as states advance.
- Because tracking and generation both flow through `setQueryData`, the same subscription infrastructure (§2.6/§5) is reused.

---

## 5. Real-time tracking UI (pluggable renderers)

Two shapes today/tomorrow:
- **Retail:** shipping-progress **timeline** (discrete milestones, slow cadence).
- **Food:** **live map** with a moving courier (continuous geo updates, fast cadence).

The tracking slot (§3) selects the renderer; the transport is shared.

### 5.1 Renderer selection

`cfg.slots.tracking.type` resolves the renderer:
- `tracking.shippingTimeline` → animated milestone timeline (checkmarks pop with haptic on each new milestone).
- `tracking.liveCourierMap` → map with an interpolated, smoothly-moving courier marker + ETA.

Both consume a **common `TrackingStream`** shape so the data layer is identical; only presentation differs:

```ts
type TrackingEvent =
  | { kind: "milestone"; orderId: string; step: string; at: string }                 // retail
  | { kind: "location";  orderId: string; lat: number; lng: number; etaSec: number } // food
  | { kind: "status";    orderId: string; status: OrderStatus };                     // both
```

### 5.2 Transport — **SSE as default, WebSocket where bidirectional/high-frequency**

| Need | Choice | Why |
|---|---|---|
| Retail tracking (server→client, low frequency) | **SSE** | Built-in auto-reconnect + `Last-Event-ID` replay, works through proxies/LBs, trivial server side, resumes mid-stream. ([SSE vs WS 2025](https://getstream.io/blog/websocket-sse/)) |
| Food live courier (high-frequency geo, possibly client→server presence) | **WebSocket** | Better battery profile for sustained high-frequency streams (radio stays in low-power between messages vs SSE reconnect churn); bidirectional if we add client signals. We implement our own backoff + resync. |
| Generation stream (§4) | **SSE** | Same replay/reconnect benefits; one-directional. |

We hide both behind one **`RealtimeClient`** adapter exposing `subscribe(channel, onEvent)` with: exponential backoff, jittered reconnect, cursor/`Last-Event-ID` resume, subscribe-on-focus / unsubscribe-on-blur, and foreground/background awareness (mobile: drop the socket in background, resync on resume). Events land in the Query cache (§2.6).

**Contract we need from the realtime team:** stable per-order channel, monotonic event ids/cursor for replay, heartbeat interval, and a documented backfill ("give me everything since cursor X") so a reconnect never loses a milestone or a courier jump.

### 5.3 Map technology recommendation

**Recommendation: MapLibre (via `maplibre-react-native` on mobile, MapLibre GL JS on web) with a vector-tile provider (e.g. MapTiler), and Mapbox as a paid upgrade path if we need turn-by-turn/navigation polish.**

| Option | Pros | Cons | Fit |
|---|---|---|---|
| **MapLibre** ✅ | Open-source, no per-map licensing/vendor lock-in, vector tiles, shared API web+RN, full styling control for "dopamine" map theming, smooth custom marker animation | Bring-your-own tiles (provider cost), fewer turnkey navigation extras | **Default** — cost-predictable, themable, one API across platforms |
| **Mapbox** | Richest features (navigation SDK, traffic), polished | Commercial pricing, lock-in | Upgrade if courier ETA/routing becomes core |
| **Apple Maps (react-native-maps)** | Easiest iOS setup, native | iOS-only feel diverges from Android (Google Maps); less custom styling; weak web | Rejected as primary (we want one themable stack across web+mobile) |

Courier marker: interpolate between `location` events with Reanimated (or native `CADisplayLink`-driven animation if we promote the map to a SwiftUI hero view) for buttery movement; snap-to-road optional via backend-provided path.

---

## 6. Design system & "dopamine" polish

### 6.1 Tokens (author once, emit per platform)

**Style Dictionary** authors a single token source → emits: TS/JS objects (RN + web), CSS variables (web), and, where we use native escape hatches, a Swift/Kotlin token file. Tokens cover color, type scale, spacing, radii, elevation, **motion** (durations, springs, easing), and **feedback intents** (haptic + sound mapped to semantic events, not raw calls).

```ts
// feedback intents are semantic; platform adapters map them to real APIs
type FeedbackIntent = "tap" | "addToCart" | "orderPlaced" | "milestoneReached" | "error";
```

### 6.2 Animation strategy per platform

| Platform | Engine | Use |
|---|---|---|
| **RN (iOS/Android)** | **Reanimated 3** (UI-thread worklets, 120fps) + **Gesture Handler** + **Moti** (declarative wrapper) + **Skia** for bespoke effects (shimmer, confetti, generative flourishes) | Default for all in-app motion; runs on the UI thread so animations stay smooth even while JS generates listings. ([Reanimated/Moti/Skia 2026](https://www.pkgpulse.com/guides/react-native-reanimated-vs-moti-vs-skia-animation-2026)) |
| **Web** | **Framer Motion** (+ CSS transitions, view transitions API) | Mirror the motion tokens so curves/durations match mobile. |
| **Native hero views** | **SwiftUI animations** (later Compose) | Only on the governed hero list (order-placed celebration, live map) where we want Apple-grade fluidity. |

**Shared "motion tokens"** keep spring/duration/easing identical across engines so the brand *feels* the same everywhere.

### 6.3 Haptics & sound

- **Haptics:** `expo-haptics` on mobile, mapped from semantic intents (e.g. `orderPlaced` → success notification haptic + a heavier custom Core-Haptics pattern on iOS via a tiny native module). Web: no-op / optional vibration.
- **Sound:** short, mixable cues (`expo-audio`) for add-to-cart and order-placed; **off by default-respecting silent switch**, user-toggleable, ducked, never blocking.
- **Choreography:** the satisfying moments (add-to-cart, place-order, milestone) fire **on optimistic state** (§2.4) so feedback is instant; reconcile silently.

### 6.4 Signature micro-interactions (the "dopamine" surface)

- Add-to-cart: item flies to cart, cart badge bounces, light haptic + tick.
- Place order: full-screen celebratory moment (Skia confetti / generative burst) + success haptic + sound; order card slides into "tracking".
- Each tracking milestone: checkmark pops, subtle haptic, gentle sound; food courier marker glides + ETA counts down.
- Pull-to-refresh, skeleton shimmer, staggered card reveals (§4).

### 6.5 Accessibility (non-negotiable, ships from day one)

- **Respect reduced-motion / reduce-transparency:** all decorative animation has a calm fallback (cross-fade instead of motion); gate confetti/parallax behind the OS setting.
- Full screen-reader support (RN accessibility props / ARIA on web); generation states announced politely ("3 listings still generating").
- Haptics/sound never the *only* signal — always paired with visual state.
- Contrast-checked tokens; dynamic type / font scaling honored; min 44pt targets.
- Captions/labels for all imagery (including AI-generated — alt text from the pipeline).

---

## 7. Repo / code-sharing structure

### 7.1 **Monorepo** (recommended) — pnpm workspaces + Turborepo

A single monorepo maximizes sharing for a small team and keeps codegen, tokens, and the registry in one place. Outside contributors clone once and get everything.

```
repo/
  apps/
    mobile/            # Expo app (iOS + Android), Expo Router
    web/               # Next.js app, React
  packages/
    api-client/        # transport-agnostic ApiClient + codegen'd types + Zod
    domain/            # models, state machines, cart/order logic
    sdui/              # VerticalConfig schema + component registry + SlotRenderer
    ui-core/           # shared cross-platform components/hooks (behavior)
    ui-web/            # web leaf components
    ui-native/         # RN leaf components
    design-tokens/     # Style Dictionary source + generated outputs
    realtime/          # RealtimeClient adapter (SSE/WS), reconnection
    feature-retail/    # retail feature module (registers renderers)
    feature-food/      # food feature module (added later, additively)
  native/
    ios-hero-views/    # SwiftUI escape-hatch views (Fabric/Nitro)
    android-hero-views/# (later)
  tooling/             # eslint, tsconfig, codegen config, scripts
```

> Polyrepo is rejected: it fragments the shared core (registry/tokens/codegen), raises onboarding cost, and complicates atomic cross-cutting changes — all worse for a small + external team.

### 7.2 Codegen of API types/clients from the backend schema

- **If GraphQL:** **GraphQL Code Generator** (`client` preset / `gql.tada`) → typed documents + types into `api-client`. Avoid generating hooks; generate documents and feed them to our `ApiClient` so we stay transport-agnostic. ([graphql-codegen](https://the-guild.dev/graphql/codegen))
- **If REST/OpenAPI:** **`@hey-api/openapi-ts`** → typed client + types, plus **Zod** schemas at boundaries. ([codegen comparison](https://saschb2b.com/skills/codegen-api))
- Either way: generated types live in `packages/api-client`; **runtime Zod validation at every network boundary**; codegen runs in CI and on a schema-change hook so client/back-end never drift.

---

## 8. Tooling

| Concern | Choice | Notes |
|---|---|---|
| **Mobile build/release** | **EAS Build** + EAS Submit | Cloud iOS/Android builds, no local Xcode farm; managed credentials. |
| **OTA updates** | **EAS Update** | Ship JS/asset fixes + *new vertical feature modules* in minutes without store review (native changes still need a build). Hermes bytecode diffing + phased rollouts + rollback. CodePush/App Center retired (Mar 2025) — EAS Update is the standard. Stay store-compliant: OTA delivers **our** bundle calling **audited native APIs only** — no runtime self-modifying/remote code. ([EAS Update OTA guide](https://reactnativerelay.com/article/react-native-ota-updates-eas-update-rollouts-rollbacks-cicd), [store OTA policy](https://bitrise.io/blog/post/what-app-stores-allow-with-ota-updates-apple-and-google-policy-explained)) |
| **Web build/deploy** | Next.js on Vercel (or equivalent) | SSR/ISR for shareable, SEO-friendly listing pages. |
| **CI** | GitHub Actions + Turborepo remote cache | Lint, typecheck, codegen-drift check, unit/component tests, EAS build/update on tagged branches; affected-only builds via Turbo. |
| **Testing** | Vitest/Jest (unit) · React Native Testing Library / RTL (component) · **Maestro** (mobile E2E) · Playwright (web E2E) · Storybook (registry components in isolation across verticals) | Snapshot the SDUI registry per vertical so new verticals get coverage by construction. |
| **Feature flags / experiments** | A flag service (e.g. Statsig/LaunchDarkly/PostHog) | Gate verticals, new SDUI component versions, and dopamine experiments; flags + SDUI versioning together enable safe per-vertical rollout & A/B. |
| **Observability** | Sentry (RN + web) + analytics on semantic events | Track SDUI fallbacks (unknown/failed descriptors), generation failures, stream reconnects — the things that silently degrade UX. |
| **Lint/format/types** | ESLint + Prettier + strict TS, shared configs in `tooling/` | Low-friction for outside contributors; enforced in CI. |

---

## 9. Risks & mitigations (summary)

| Risk | Mitigation |
|---|---|
| RN New-Arch third-party native dep gaps | Pin Expo SDK; vet deps for New-Arch support at selection; prefer Expo/Nitro modules. |
| Web RN-Web "uncanny" components | Fork presentation on web (Next.js + web-native leaves); share behavior only. |
| Native escape hatches sprawl | Written, governed allowlist; each native view implements a documented props contract; keep tiny. |
| SDUI drift / client crashes on unknown components | Versioned descriptors + graceful fallbacks + telemetry; Storybook coverage per vertical. |
| Generation stream loss mid-flight | Cursor/`Last-Event-ID` replay + idempotent backfill contract. |
| OTA rejected for "self-modifying" | OTA ships only our audited bundle; no remote code execution; SDUI is config-from-known-catalog. |
| Battery drain from realtime | Foreground-only sockets, drop/resume on background, tuned heartbeats, SSE where frequency is low. |

---

## 10. Contracts required from sibling teams (consolidated)

**Backend:**
- Transport-agnostic surface usable behind one `ApiClient` (REST/OpenAPI *or* GraphQL — provide a schema we can codegen from).
- **`VerticalConfig`** per session/vertical: slot → versioned `ComponentDescriptor` mapping (§3), forward-compatible (open `vertical` string, `schemaVersion`).
- Stable `id`s for listings/orders; idempotency-key support on `placeOrder`.
- Persisted, replayable order history.

**AI pipeline:**
- Search returns immediately with `pending` placeholders (count + shape).
- Per-listing lifecycle stream: `pending → partial → ready | failed`, field-level granularity (text before images), image `pending→ready` with **BlurHash/ThumbHash** placeholders and alt text.
- `failed` carries `retryable` + reason; everything cursor-replayable.

**Real-time team:**
- Per-order channel; **SSE** for retail/generation, **WebSocket** for food live-courier.
- Monotonic event ids/cursor, `Last-Event-ID`/backfill ("since cursor X"), documented heartbeat, common `TrackingEvent` shape (milestone | location | status).

---

## 11. Summary of recommendations

1. **Stack:** Expo + React Native (New Architecture) for iOS/Android + React (Next.js) for web, one TypeScript monorepo; native SwiftUI/Compose only on a governed list of hero surfaces via Fabric/Nitro. Rejected Flutter (rendered iOS + weak web + team), KMP (iOS UI maturity + team), and full-native-everywhere (3x cost for a small team).
2. **State/data:** TanStack Query v5 (transport-agnostic), query-key factories, persisted cache + paused/persisted mutation queue for offline; optimistic add-to-cart and place-order with idempotency keys.
3. **Extensibility:** bounded server-driven UI — a versioned `VerticalConfig` maps slots to `ComponentDescriptor`s resolved by a shared **component registry**; verticals are **additive feature modules**, so FOOD = one module + config, no rewrite, no new routes.
4. **Generation UX:** explicit `pending → partial → ready → failed` listing lifecycle streamed in; instant skeletons, progressive text + BlurHash→full image loading, staggered reveals, gentle failure/retry.
5. **Tracking:** pluggable renderers (shipping timeline vs live courier map) selected by config; SSE for retail/generation, WebSocket for high-frequency food courier; **MapLibre** (web + RN, themable, no lock-in) with Mapbox as paid upgrade.
6. **Dopamine + a11y:** Style-Dictionary motion/haptic/sound tokens shared across Reanimated/Skia (mobile), Framer Motion (web), SwiftUI (hero); feedback fires on optimistic state; reduced-motion and screen-reader support from day one.
7. **Repo/tooling:** pnpm + Turborepo monorepo; codegen API types (graphql-codegen or hey-api) + Zod boundaries; EAS Build/Submit + **EAS Update** OTA (store-compliant, ships new vertical modules fast); GitHub Actions CI, Maestro/Playwright/Storybook tests, feature flags + Sentry.
8. **Contracts needed:** backend `VerticalConfig` + idempotent order API; AI pipeline streaming listing lifecycle with image placeholders; realtime team's per-order channels with cursor replay and a common `TrackingEvent` shape (see §10).
