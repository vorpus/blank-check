# Stage 01 · Doc 05 — Shared Contracts & SDK

> **Workstream:** Shared Contracts / SDK · **Owner:** Platform/Contracts track · **Date:** 2026-06-21
> **Status:** Active — Stage 1 build target.
> **Scope:** The pnpm monorepo layout, the shared `packages/contracts` (Zod schemas + inferred TS types), the typed API `packages/sdk` generated from the `/v1` OpenAPI 3.1 spec, the realtime event type definitions, and the canonical TypeScript shapes for the charter's §4 contracts.
>
> **This doc is the single source of truth for the Stage-1 wire contracts.** Where the [charter](./README.md) §4 freezes a seam in prose, *this doc gives it a canonical Zod schema + inferred type*. Every sibling doc references THESE definitions — it does not re-declare them:
> - [`01-backend-api.md`](./01-backend-api.md) emits the OpenAPI `/v1` spec from these shapes and uses these Zod schemas server-side to validate inputs/outputs.
> - [`02-fake-generation.md`](./02-fake-generation.md) implements the `GenerationProvider` types defined here.
> - [`03-web-frontend.md`](./03-web-frontend.md) consumes `packages/sdk` and re-uses these Zod schemas to parse responses.
> - [`04-docker-infra.md`](./04-docker-infra.md) wires the `make sdk` codegen step into the build.
>
> Realizes architecture **00 §4** (cross-cutting contracts), **01 §3–§4** (API shapes + generation seam), **03 §1.3 / §7** (what's shared across platforms; monorepo). Scope is Stage 1: **retail only**; geo, `trackingMode: "map"`, and `embedding` fields are **defined but reserved** (typed now, unused until Stage 7 / Stage 2). See §9.

---

## 1. Design rules (the contract discipline)

Five rules govern everything below. They come straight from the charter and architecture 00 §6.

1. **One source of truth per shape.** A wire shape is declared exactly once, here, as a Zod schema. Its TypeScript type is *inferred* (`z.infer`), never hand-written in parallel. Backend, fake-gen, and web all import from `@dopamine/contracts`.
2. **Zod at every boundary, both directions.** The same schema validates inputs on the **server** (reject bad requests → `400`) and parses responses on the **client** (never trust the network — architecture 03 §1.3). Generated OpenAPI types describe *transport*; Zod schemas *enforce* it at runtime.
3. **Vertical-agnostic from day one.** No retail-specific or food-specific field lives in a core shape. Per-vertical data rides in `display.stages[]`, `trackingMode`, `capabilities`, and JSONB `attributes`. The client carries **no state enum** (charter §6.5).
4. **Additive within `/v1`.** New fields are optional or have defaults; nothing is removed or repurposed. **Adding a vertical never bumps the version** (architecture 00 §6.5, 01 §3.3). Breaking change → `/v2`. See §9.
5. **The database is the source of truth; transport is an accelerator.** SSE events carry `seq` + `ts`; clients reconcile against a snapshot (`GET /v1/orders/{id}/tracking`) on reconnect (architecture 00 §6.6). Every event type here carries `seq` + `ts`.

---

## 2. Monorepo layout (pnpm workspaces)

One pnpm + Turborepo monorepo per architecture 03 §7. Stage 1 ships the subset of packages the local skeleton needs; the structure is a strict subset of the arch-03 §7.1 layout so Stage 6 (mobile) adds `apps/mobile` and `packages/ui-*` **additively**, with no move of the contracts/SDK packages.

```
blank-check/
  apps/
    api/                 # NestJS modular monolith (:8080). Identity, catalog, search,
                         #   cart, orders, realtime SSE gateway, generation gateway.
                         #   Emits the /v1 OpenAPI 3.1 spec. → doc 01
    worker/              # BullMQ entrypoint. SAME Docker image as api, different CMD.
                         #   Fulfillment sim + generation enrichment. → doc 01 / 04
    web/                 # Next.js App Router (:3000). Consumes @dopamine/sdk. → doc 03
    fake-gen/            # Standalone HTTP service (:8090) implementing GenerationProvider.
                         #   Swapped for the real pipeline in Stage 2. → doc 02
  packages/
    contracts/           # ★ THIS DOC. Zod schemas + inferred TS types. Zero runtime deps
                         #   beyond zod. Imported by api, worker, fake-gen, web, sdk.
    sdk/                 # Typed ApiClient: openapi-typescript types + a thin REST impl
                         #   + the SSE/tracking client. Imported by web (and mobile @ S6).
    config/              # Shared tsconfig bases + eslint + prettier presets.
  packages.json          # pnpm workspace root
  pnpm-workspace.yaml
  turbo.json             # build graph: contracts → sdk → apps
  Makefile               # make up | seed | sdk | logs  (→ doc 04)
```

> **`apps/worker` vs shared:** per the charter §2, `worker` and `api` are **one codebase / one Docker image with two entrypoints**. We keep `apps/worker` as a thin package whose `main` re-exports the api app bootstrapped in worker mode (BullMQ processors only, no HTTP listener). Doc 04 owns the entrypoint/`CMD` split.

### 2.1 `pnpm-workspace.yaml`

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

### 2.2 What each package exports

| Package | Name | Exports | Consumed by | Dependencies |
|---|---|---|---|---|
| `packages/contracts` | `@dopamine/contracts` | Every Zod schema + inferred type in §4–§8; ID helpers (§7); the error envelope (§7); enums (`Origin`, `MediaStatus`, `TrackingMode`). | `api`, `worker`, `fake-gen`, `web`, `sdk` | `zod` only |
| `packages/sdk` | `@dopamine/sdk` | `ApiClient` interface; `createRestApiClient(opts)`; `TrackingClient` (SSE + polling fallback); generated `paths`/`components` types (`openapi.gen.ts`). | `web` (Stage 6: `mobile`) | `@dopamine/contracts` |
| `packages/config` | `@dopamine/config` | `tsconfig.base.json`, `tsconfig.lib.json`; `eslint-preset.js`; `prettier.config.js`. | all packages/apps | — |

**Dependency direction is strict and acyclic:** `config` ← everything; `contracts` ← `sdk`, apps; `sdk` ← `web`. `contracts` depends on nothing but `zod`, so it can be imported by the browser bundle, the NestJS server, and the tiny `fake-gen` service alike without dragging in server code. Turborepo builds `contracts` → `sdk` → apps in that order.

### 2.3 `packages/contracts` internal structure

```
packages/contracts/src/
  ids.ts            # ULID prefixes + brand types + parse/format helpers (§7)
  money.ts          # Money schema, cents helpers (§7)
  errors.ts         # ErrorEnvelope (§7)
  enums.ts          # Origin, MediaStatus, TrackingMode, GenerationStatus
  media.ts          # Media, MediaAsset (§4.1)
  listing.ts        # Listing, DisplayBlock-on-listing? (no — display is order-side)
  order.ts          # Order, OrderItem, DisplayBlock, Capabilities (§4.1)
  generation.ts     # GenerationRequest, GenerationResult, GenerationProvider (§4.2)
  realtime.ts       # TrackingEvent, GeoPosition, ImagesReady/Degraded, gen.* (§4.3)
  identity.ts       # DeviceIdentityRequest/Response, bearer token (§4.4)
  index.ts          # re-exports everything; the package's public surface
```

---

## 3. The OpenAPI → SDK pipeline

Two type systems, one source of truth, complementary jobs:

```
                 ┌──────────────────────────────────────────────────────┐
 @dopamine/      │  Zod schemas (hand-authored, canonical)               │
 contracts       │  → z.infer<> TS types                                 │
                 └───────────┬───────────────────────┬──────────────────┘
                             │ used at runtime        │ used at runtime
                             │ (server: validate in)  │ (client: parse out)
                             ▼                         ▼
              ┌──────────────────────────┐   ┌───────────────────────────┐
   doc 01 →   │  apps/api (NestJS)        │   │  apps/web / sdk            │
              │  controllers import Zod   │   │  parse responses w/ Zod    │
              │  + emit OpenAPI 3.1 spec  │   │                            │
              └───────────┬──────────────┘   └───────────────────────────┘
                          │ GET /v1/openapi.json  (build-time dump)
                          ▼
              ┌──────────────────────────┐
   make sdk → │ openapi-typescript        │  spec → packages/sdk/src/openapi.gen.ts
              │ (transport types only)    │  (paths, components, operations)
              └───────────┬──────────────┘
                          ▼
              ┌──────────────────────────┐
              │ packages/sdk: ApiClient   │  thin REST impl typed by the generated
              │ + REST impl + Tracking    │  paths, runtime-validated by contracts Zod
              └──────────────────────────┘
```

### 3.1 Why two type systems (and how they relate)

- **Zod schemas (`@dopamine/contracts`)** are the **runtime boundary validators** and the canonical authoring surface. They produce TS types via `z.infer`. They are what actually runs `.parse()` on the server (input) and client (output).
- **Generated OpenAPI types (`openapi.gen.ts`)** describe the **transport** — the exact `paths`, `operations`, request/response shapes the server published. They give the `ApiClient` per-endpoint type safety (URL → params → response) without hand-maintaining a method table.

They are kept in agreement structurally: the NestJS controllers build their request/response DTOs from the **same** Zod schemas (via a Zod-aware OpenAPI generator — see doc 01), so the emitted spec is a faithful projection of the contracts. The generated types are *derived*; the Zod schemas are *authored*. A `codegen-drift` CI check fails the build if `openapi.gen.ts` is out of date relative to the committed spec.

> **Rule of thumb:** if it must be *checked at runtime*, it's a Zod schema in `contracts`. If it only needs to *type the call site*, it's a generated type in `sdk`. Response bodies are both: the SDK types the call, then hands the body to the matching Zod schema to `.parse()` before returning it.

### 3.2 The codegen command (`make sdk`)

Owned operationally by doc 04; defined here so the shape is canonical:

```makefile
# Makefile (excerpt — doc 04 owns the surrounding targets)
sdk: ## Regenerate the typed SDK from the running/api-built OpenAPI spec
	# 1. dump the spec from the NestJS app (no DB needed — pure schema build)
	pnpm --filter @dopamine/api run openapi:dump > packages/sdk/openapi/v1.json
	# 2. generate transport types from the spec
	pnpm --filter @dopamine/sdk exec openapi-typescript \
	    packages/sdk/openapi/v1.json \
	    -o packages/sdk/src/openapi.gen.ts
	# 3. typecheck the SDK against the freshly generated types
	pnpm --filter @dopamine/sdk run typecheck
```

```jsonc
// apps/api/package.json
{ "scripts": { "openapi:dump": "ts-node src/openapi-dump.ts" } }
// → boots the Nest app in "spec mode", writes the OpenAPI 3.1 document to stdout, exits.
```

`make sdk` runs in CI on every change to `apps/api` and is a **drift gate**: if regenerating the spec or types produces a diff, the job fails. The committed `packages/sdk/openapi/v1.json` is the published, reviewable artifact.

> **Tooling note (charter §3):** charter pins **openapi-typescript / orval**; arch-03 §7.2 mentions `@hey-api/openapi-ts` as an alternative. For Stage 1 we use **openapi-typescript** for the type layer (fast, zero-runtime, just types) and **hand-write the thin REST impl** (§5) rather than generating a fat client — keeping the `ApiClient` interface stable and identical for web now and mobile in Stage 6. Orval/hey-api remain drop-in alternatives if we later want generated method stubs; the `ApiClient` interface insulates consumers from that choice.

### 3.3 SDK shape (preview; full in §5)

```ts
import type { paths } from "./openapi.gen";   // transport types
import { OrderSchema, SearchResultSchema } from "@dopamine/contracts"; // runtime validators

export interface ApiClient { /* … §5 … */ }
export function createRestApiClient(opts: ApiClientOptions): ApiClient { /* … */ }
export class TrackingClient { /* SSE + polling fallback — §6.5 */ }
```

The same `ApiClient` interface is consumed **identically by web now and mobile in Stage 6** (architecture 03 §1.3 — "transport-agnostic `ApiClient` with REST impl"). Mobile swaps storage/EventSource adapters, not the interface.

---

## 4. Canonical contract types

These are the authoritative definitions for charter §4. **Every sibling doc references these.** All schemas live in `@dopamine/contracts`. TS types are `z.infer<typeof …Schema>`.

### 4.1 Vertical-agnostic listing / order payload (charter §4.1)

Presentation is carried **as data**. Clients render the lifecycle from `display.stages`; they never hardcode state enums (architecture 00 §4.1, 01 §3.4).

```ts
// enums.ts
import { z } from "zod";

export const TrackingModeSchema = z.enum(["timeline", "map"]); // "map" RESERVED (Stage 7)
export type TrackingMode = z.infer<typeof TrackingModeSchema>;

export const MediaStatusSchema = z.enum([
  "generating_text",   // listing text still streaming/forming
  "generating_media",  // text ready, hero image still rendering
  "ready",             // fully materialized
  "degraded",          // usable but media fell back (placeholder kept)
]);
export type MediaStatus = z.infer<typeof MediaStatusSchema>;
```

```ts
// money.ts — integer cents + ISO-4217 currency, never floats (arch 01 §5.3)
export const MoneySchema = z.object({
  amount_cents: z.number().int(),         // 1299 == $12.99
  currency: z.string().length(3),         // "USD"
});
export type Money = z.infer<typeof MoneySchema>;
```

```ts
// media.ts
export const MediaAssetSchema = z.object({
  url: z.string().url(),
  kind: z.enum(["image", "video"]).default("image"),
  blurhash: z.string().nullable().default(null), // RESERVED-ish: Stage 1 may send a flat
                                                 //  placeholder; real blurhash in Stage 2/3
  aspect_ratio: z.number().positive().default(1), // width/height, e.g. 1.0 square
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

export const MediaSchema = z.object({
  status: MediaStatusSchema,
  hero: MediaAssetSchema.nullable(),       // null while generating_text
  alternates: z.array(MediaAssetSchema).default([]),
  expected_ready_ms: z.number().int().nonnegative().nullable().default(null), // hint for skeletons
  generation_id: z.string(),               // gen_… — keys async images.ready/degraded swap
});
export type Media = z.infer<typeof MediaSchema>;
```

```ts
// listing.ts
export const ListingSchema = z.object({
  id: z.string(),                          // lst_…
  verticalId: z.string(),                  // "retail" in Stage 1 (open string — fwd-compat)
  storefrontId: z.string(),                // sto_…
  title: z.string(),
  description: z.string(),
  price: MoneySchema,
  attributes: z.record(z.unknown()).default({}), // per-vertical JSONB (size/color for retail)
  media: MediaSchema,
  origin: OriginSchema,                     // §4.2 — how this listing came to exist
  canonicalQuery: z.string().nullable().default(null),
  // RESERVED: semantic dedup (Stage 2). Typed now so the shape never changes.
  embedding: z.array(z.number()).nullable().default(null),
  createdAt: z.string().datetime(),
});
export type Listing = z.infer<typeof ListingSchema>;
```

```ts
// order.ts
export const DisplayStageSchema = z.object({
  key: z.string(),        // "shipped" — opaque to the client
  label: z.string(),      // "Shipped" — server-provided, human-facing
  reached: z.boolean(),
  current: z.boolean().default(false),
});
export type DisplayStage = z.infer<typeof DisplayStageSchema>;

export const DisplayBlockSchema = z.object({
  stages: z.array(DisplayStageSchema),     // ordered, server-defined lifecycle
  trackingMode: TrackingModeSchema,        // "timeline" in Stage 1
});
export type DisplayBlock = z.infer<typeof DisplayBlockSchema>;

export const CapabilitiesSchema = z.object({
  liveLocation: z.boolean().default(false), // false for retail; true selects geo channel (S7)
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const OrderItemSchema = z.object({
  id: z.string(),                          // oit_…
  listingId: z.string(),                   // lst_…
  titleSnapshot: z.string(),               // frozen at order time (arch 01 §1.2/§5.3)
  unitPriceSnapshot: MoneySchema,
  qty: z.number().int().positive(),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

export const OrderSchema = z.object({
  id: z.string(),                          // ord_…
  verticalId: z.string(),
  storefrontId: z.string(),
  state: z.string(),                       // current state key; validated by the vertical's
                                           //  machine server-side. NOT a client enum.
  items: z.array(OrderItemSchema),
  total: MoneySchema,
  display: DisplayBlockSchema,             // ← clients render from THIS
  capabilities: CapabilitiesSchema,
  streamUrl: z.string(),                   // "/v1/orders/{id}/stream"
  placedAt: z.string().datetime(),
});
export type Order = z.infer<typeof OrderSchema>;
```

> **Search result envelope.** Search returns a *populated grid* (arch 00 §4.2), not one listing. Each card carries its own `media.status`, so the grid renders skeleton → placeholder → ready per card.
> ```ts
> export const SearchResultSchema = z.object({
>   listings: z.array(ListingSchema),
>   generation: z.object({                 // present on a miss (arch 01 §4.1)
>     status: GenerationStatusSchema,       // "pending" | "ready" | "degraded"
>     canonicalQuery: z.string(),
>     generationId: z.string(),             // gen_…
>     pollAfterMs: z.number().int().nonnegative(),
>   }).nullable().default(null),
> });
> export type SearchResult = z.infer<typeof SearchResultSchema>;
> ```

### 4.2 Generation contract (charter §4.2 — backend ↔ fake-gen, identical to the real one)

The `fake-gen` service (doc 02) implements `GenerationProvider`. The **backend** owns canonicalization, the exact-cache (`canon_key → listing_id`), the generation lock, idempotency, image ingestion to MinIO, and the transactional catalog write (charter §4.2, arch 01 §4.4) — fake-gen only "produces content."

```ts
// enums.ts
export const OriginSchema = z.enum([
  "exact_cache",     // canon_key hit in Redis → existing listing reused
  "semantic_reuse",  // pgvector near-dup reuse (RESERVED behavior — Stage 2; enum present now)
  "seed",            // from the seeded starter catalog
  "generated",       // freshly produced by the provider
]);
export type Origin = z.infer<typeof OriginSchema>;

export const GenerationStatusSchema = z.enum(["pending", "ready", "degraded"]);
export type GenerationStatus = z.infer<typeof GenerationStatusSchema>;
```

```ts
// generation.ts
export const GenerationRequestSchema = z.object({
  query: z.string(),                       // raw user query
  vertical: z.string(),                    // "retail"
  deviceId: z.string(),                    // dev_… (anon identity)
  locale: z.string().default("en-US").optional(),
  requestId: z.string(),                   // idempotency / correlation id
});
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;

// Fast-path response — returned synchronously so search never blocks (charter §4.2)
export const GenerationResultSchema = z.object({
  listing_id: z.string(),                  // lst_…
  generation_id: z.string(),               // gen_… — keys the async images.ready/degraded
  origin: OriginSchema,
  status: MediaStatusSchema,               // generating_text | generating_media | ready | degraded
  listing: ListingSchema,                  // full listing incl. its `media` block
});
export type GenerationResult = z.infer<typeof GenerationResultSchema>;
```

```ts
// generation.ts — the seam the AI track implements (charter §4.2 / arch 01 §4.2 / arch 02 §8.1)
export interface GenerationProvider {
  /** Fast path: produce (or reuse) a listing synchronously; media may still be generating. */
  generateListing(input: GenerationRequest): Promise<GenerationResult>;
  /** Optional batch fill for the blended search grid (arch 00 §4.2). Stage 1: simple form. */
  generateGrid?(input: GenerationRequest & { count: number }): Promise<GenerationResult[]>;
}
```

The async completion (`images.ready` / `images.degraded`) is **not** a method on the provider — it rides the realtime fan-out, keyed on `generation_id` (§4.3). Stage 1 fakes the *content* (placeholder text + a generated SVG/solid-color image in MinIO) but honors **every field and state transition**, so Stage 2 is a drop-in (charter §4.2).

### 4.3 Realtime events (charter §4.3 — realtime ↔ web)

Channel `order:{orderId}` carries `tracking_event`. Generation swaps ride the **same** fan-out keyed on `generation_id`. **Every event carries a per-order monotonic `seq` and a server `ts`.** Client rules: apply in `seq` order, drop `seq <= lastApplied`, catch up on reconnect via snapshot (`GET /v1/orders/{id}/tracking`) + replay from `seq` (charter §4.3, arch 00 §4.3).

```ts
// realtime.ts
const EventBaseSchema = z.object({
  seq: z.number().int().nonnegative(),     // per-order monotonic, gap-free
  ts: z.string().datetime(),               // server clock — trust over local
});

// RESERVED (Stage 7, map verticals only). Typed now; never emitted in Stage 1.
export const GeoPositionSchema = z.object({
  orderId: z.string(),
  lat: z.number(),
  lng: z.number(),
  heading: z.number().nullable().default(null),
});
export type GeoPosition = z.infer<typeof GeoPositionSchema>;

// order:{orderId} — state changes (Stage 1's live tracking)
export const TrackingEventSchema = EventBaseSchema.extend({
  type: z.literal("tracking_event"),
  orderId: z.string(),
  state: z.string(),                       // new state key
  label: z.string(),                       // human-facing
  display: DisplayBlockSchema.optional(),  // server may resend the full stage list
});
export type TrackingEvent = z.infer<typeof TrackingEventSchema>;

// RESERVED: emitted only by map-tracking verticals (Stage 7). Defined for forward-compat.
export const GeoEventSchema = EventBaseSchema.extend({
  type: z.literal("geo_position"),
  position: GeoPositionSchema,
});
export type GeoEvent = z.infer<typeof GeoEventSchema>;

// Generation media swaps — keyed on generation_id, ride the same fan-out
export const ImagesReadySchema = EventBaseSchema.extend({
  type: z.literal("images.ready"),
  generation_id: z.string(),
  media: MediaSchema,                      // thin block the client swaps in
});
export type ImagesReady = z.infer<typeof ImagesReadySchema>;

export const ImagesDegradedSchema = EventBaseSchema.extend({
  type: z.literal("images.degraded"),
  generation_id: z.string(),
  media: MediaSchema,                      // status: "degraded"; hero is the kept placeholder
});
export type ImagesDegraded = z.infer<typeof ImagesDegradedSchema>;

// Streaming text generation progress (arch 00 §4.2 — COLD search "types out")
export const GenTextDeltaSchema = EventBaseSchema.extend({
  type: z.literal("gen.text.delta"),
  generation_id: z.string(),
  listing_id: z.string(),
  field: z.enum(["title", "description"]),
  delta: z.string(),
});
export const GenTextDoneSchema = EventBaseSchema.extend({
  type: z.literal("gen.text.done"),
  generation_id: z.string(),
  listing_id: z.string(),
});

// Discriminated union — every realtime event the client may receive
export const RealtimeEventSchema = z.discriminatedUnion("type", [
  TrackingEventSchema,
  GeoEventSchema,            // RESERVED
  ImagesReadySchema,
  ImagesDegradedSchema,
  GenTextDeltaSchema,
  GenTextDoneSchema,
]);
export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;
```

**SSE framing.** Transport is SSE from `api`, fanned out via Redis pub/sub, with `Last-Event-ID` replay (charter §4.3, arch 01 §3.5). The SSE `id:` line is the event `seq`; the `event:` line is the `type`; `data:` is the JSON body.

```
id: 7
event: tracking_event
data: {"type":"tracking_event","seq":7,"ts":"2026-06-21T12:00:01Z","orderId":"ord_123","state":"shipped","label":"Shipped"}

id: 8
event: images.ready
data: {"type":"images.ready","seq":8,"ts":"2026-06-21T12:00:03Z","generation_id":"gen_abc","media":{"status":"ready","hero":{"url":"http://minio/...","kind":"image","blurhash":null,"aspect_ratio":1},"alternates":[],"expected_ready_ms":null,"generation_id":"gen_abc"}}
```

On reconnect the client sends `Last-Event-ID: 7`; the server replays from `seq > 7`. **Polling `GET /v1/orders/{id}`** is the always-available fallback (charter §4.3).

### 4.4 Identity (charter §4.4 — anonymous-first)

`POST /v1/identity/device` issues/looks up an anonymous `user` keyed on `deviceId` and returns a short-lived **bearer** token. **Same bearer scheme** Stage 4 reuses for real accounts — account upgrade is "swap the token issuer," not a re-plumb (charter §4.4, arch 01 §3.2).

```ts
// identity.ts
export const DeviceIdentityRequestSchema = z.object({
  deviceId: z.string().nullable().default(null), // null on first boot → server mints one
});
export type DeviceIdentityRequest = z.infer<typeof DeviceIdentityRequestSchema>;

export const BearerTokenSchema = z.object({
  accessToken: z.string(),                 // sent as `Authorization: Bearer <token>`
  tokenType: z.literal("Bearer"),
  expiresInSec: z.number().int().positive(),
});
export type BearerToken = z.infer<typeof BearerTokenSchema>;

export const DeviceIdentityResponseSchema = z.object({
  deviceId: z.string(),                    // dev_… (echoed or newly minted)
  userId: z.string(),                      // usr_… (anonymous user row)
  token: BearerTokenSchema,
});
export type DeviceIdentityResponse = z.infer<typeof DeviceIdentityResponseSchema>;
```

A bootstrap `X-Device-Id` header is accepted as an alternative to the body field (charter §4.4); both resolve to the same anonymous `user`.

---

## 5. The typed SDK (`packages/sdk`)

A thin `ApiClient` **interface** plus one REST implementation. Consumers depend on the interface; the impl is swappable. Every response is `.parse()`d through the matching `@dopamine/contracts` Zod schema before it is returned — so the SDK is the **client-side boundary validator** (rule §1.2).

```ts
// packages/sdk/src/client.ts
import {
  type Listing, type Order, type SearchResult, type DeviceIdentityResponse,
  ListingSchema, OrderSchema, SearchResultSchema, DeviceIdentityResponseSchema,
} from "@dopamine/contracts";

export interface ApiClientOptions {
  baseUrl: string;                         // http://localhost:8080
  getToken: () => string | null;           // bearer; null before identity bootstrap
  fetch?: typeof fetch;                     // injectable (mobile/test)
}

export interface ApiClient {
  identity: {
    device(deviceId?: string | null): Promise<DeviceIdentityResponse>;
  };
  search(params: { q: string; storefrontId: string }): Promise<SearchResult>;
  listings: { get(id: string): Promise<Listing> };
  cart: {
    get(storefrontId: string): Promise<Order /* CartSchema in full impl */>;
    addItem(input: { listingId: string; qty: number }): Promise<unknown>;
  };
  orders: {
    place(input: PlaceOrderInput, idempotencyKey: string): Promise<Order>;
    get(id: string): Promise<Order>;
    list(): Promise<Order[]>;
    trackingSnapshot(id: string): Promise<TrackingSnapshot>; // snapshot + latest seq
  };
}
```

```ts
// packages/sdk/src/rest-client.ts (sketch — shows the boundary-validation pattern)
export function createRestApiClient(opts: ApiClientOptions): ApiClient {
  const doFetch = opts.fetch ?? fetch;

  async function req<T>(path: string, init: RequestInit, schema: { parse(x: unknown): T }): Promise<T> {
    const token = opts.getToken();
    const res = await doFetch(opts.baseUrl + path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    if (!res.ok) throw await toApiError(res);          // → ErrorEnvelope (§7)
    return schema.parse(await res.json());             // ← Zod parses the response
  }

  return {
    identity: {
      device: (deviceId = null) =>
        req("/v1/identity/device", { method: "POST", body: JSON.stringify({ deviceId }) },
            DeviceIdentityResponseSchema),
    },
    search: (p) =>
      req(`/v1/search?q=${encodeURIComponent(p.q)}&storefrontId=${p.storefrontId}`,
          { method: "GET" }, SearchResultSchema),
    listings: { get: (id) => req(`/v1/listings/${id}`, { method: "GET" }, ListingSchema) },
    orders: {
      place: (input, key) =>
        req("/v1/orders", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(input) },
            OrderSchema),
      get: (id) => req(`/v1/orders/${id}`, { method: "GET" }, OrderSchema),
      list: () => req("/v1/orders", { method: "GET" }, z.array(OrderSchema)),
      trackingSnapshot: (id) => req(`/v1/orders/${id}/tracking`, { method: "GET" }, TrackingSnapshotSchema),
    },
    cart: { /* … */ } as ApiClient["cart"],
  };
}
```

The generated `paths` from `openapi.gen.ts` type the URL/param/response triples at the call sites (compile-time); the Zod schemas validate the bodies (runtime). **The interface is identical for web (Stage 1) and mobile (Stage 6)** — mobile injects its own `fetch` and `getToken` (MMKV-backed), nothing else changes (arch 03 §1.3).

### 5.1 The tracking client (SSE + polling fallback)

```ts
// packages/sdk/src/tracking-client.ts
import { RealtimeEventSchema, type RealtimeEvent } from "@dopamine/contracts";

export class TrackingClient {
  private lastSeq = -1;
  constructor(private api: ApiClient, private orderId: string, private onEvent: (e: RealtimeEvent) => void) {}

  /** Snapshot first (catch up), then stream from lastSeq; fall back to polling on failure. */
  async start(streamUrl: string) {
    const snap = await this.api.orders.trackingSnapshot(this.orderId); // GET /v1/orders/{id}/tracking
    this.lastSeq = snap.latestSeq;
    snap.events.forEach((e) => this.dispatch(e));
    this.connectSse(streamUrl);     // EventSource with Last-Event-ID = lastSeq
  }

  private dispatch(raw: unknown) {
    const e = RealtimeEventSchema.parse(raw);      // ← Zod boundary validation
    if (e.seq <= this.lastSeq) return;             // drop replays/duplicates (charter §4.3)
    this.lastSeq = e.seq;
    this.onEvent(e);
  }
  // connectSse(): EventSource; on error → exponential backoff → if exhausted, poll GET /v1/orders/{id}
}
```

`EventSource` is injectable so mobile (Stage 6) supplies a React-Native EventSource polyfill; the reconnection/replay logic is shared.

---

## 6. Money, IDs, errors (cross-cutting conventions)

### 6.1 Money / units

**Integer cents + ISO-4217 currency, never floats** (arch 01 §5.3). All amounts use `MoneySchema` (§4.1). Formatting for display is a client concern; the wire is always `{ amount_cents, currency }`.

### 6.2 IDs — prefixed ULIDs

All entity IDs are **prefixed ULIDs**: `<prefix>_<26-char Crockford base32 ULID>` — sortable, collision-resistant, and self-describing in logs.

```ts
// ids.ts
export const ID_PREFIXES = {
  user: "usr", device: "dev", storefront: "sto", listing: "lst",
  order: "ord", orderItem: "oit", cart: "crt", cartItem: "cit",
  generation: "gen",
} as const;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;          // Crockford base32, no I L O U
export const prefixedId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_${ULID.source.slice(1)}`));
// e.g. ListingSchema.id uses prefixedId("lst") in the strict build.
```

Charter-named prefixes — `lst_`, `ord_`, `gen_` — are canonical. The schemas in §4 type IDs as `z.string()` for forward-compat (the format is validated by `prefixedId` server-side); the regex variant is available where strict parsing is wanted.

### 6.3 Error envelope

Every non-2xx response uses one shape, so the SDK turns it into a typed `ApiError`:

```ts
// errors.ts
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),         // "validation_error" | "not_found" | "conflict" | "rate_limited" | …
    message: z.string(),      // human-readable
    requestId: z.string(),    // correlation id (arch 01 §8.4)
    details: z.record(z.unknown()).optional(), // e.g. Zod issues on a 400
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
```

Conventional mappings (owned by doc 01, fixed here): `400 validation_error` (Zod input parse fail), `401 unauthorized`, `404 not_found`, `409 conflict` (illegal state transition / idempotency replay mismatch — arch 01 §1.4/§8.1), `429 rate_limited` (generation budget — arch 01 §8.3).

---

## 7. Server-side usage (the other boundary)

The **same** Zod schemas validate **inputs on the server** (rule §1.2). In NestJS (doc 01), a Zod validation pipe parses request bodies/queries against the contract schema; the OpenAPI generator reads the same schemas to emit the spec. So:

- Request DTO → `XxxRequestSchema.parse(body)` in a pipe → `400 validation_error` on failure.
- Response → built to satisfy `XxxSchema`, and (in dev/test) `.parse()`d before send to catch server bugs early.
- `fake-gen` (doc 02) validates its incoming `GenerationRequest` and its outgoing `GenerationResult` against the same schemas — so a contract drift in the fake provider fails loudly, exactly as the real one would in Stage 2.

This is what makes the seam honest: there is no shape that only one side knows about.

---

## 8. Versioning discipline & reserved fields

### 8.1 Additive within `/v1`

- New fields are **optional** (`.optional()`) or have a **`.default()`**, so old clients keep parsing new responses and new clients tolerate old servers (rule §4).
- Fields are never removed or repurposed inside `/v1`. A breaking change forces `/v2` (arch 01 §3.3).
- **Adding a vertical never bumps the version.** The shapes are vertical-agnostic by construction (`display.stages`, `trackingMode`, `capabilities`, JSONB `attributes`), so Stage 7's food vertical plugs in with zero contract changes (arch 00 §6.5, 01 §3.4/§6).

### 8.2 Reserved-but-unused in Stage 1 (typed now, used later)

| Field / type | Defined in | Reserved for | Stage-1 behavior |
|---|---|---|---|
| `TrackingMode = "map"` | §4.1 enums | Stage 7 (food) | Stage 1 only ever emits `"timeline"`. |
| `Capabilities.liveLocation = true` | §4.1 | Stage 7 | Always `false` for retail; no geo channel opened. |
| `GeoPosition`, `GeoEvent` | §4.3 | Stage 7 | Typed in the realtime union; **never emitted** in Stage 1. |
| `Listing.embedding` | §4.1 | Stage 2 (pgvector semantic dedup) | Always `null` in Stage 1. |
| `Origin = "semantic_reuse"` | §4.2 enums | Stage 2 | Enum value present; never returned in Stage 1 (only `exact_cache`/`seed`/`generated`). |
| `MediaAsset.blurhash` | §4.1 | Stage 2/3 (real blurhash polish) | `null` (flat placeholder) in Stage 1. |

Defining these now means the wire shape is **frozen** — later stages only start *populating* fields that already exist, never adding them. That is the whole point of pinning the contracts in Stage 1.

---

## 9. Exit checklist

Stage 1 contracts/SDK work is **done** when:

- [ ] `packages/contracts` exports a Zod schema **and** an inferred TS type for every charter §4 shape: `Listing`, `Order`, `OrderItem`, `DisplayBlock`/`DisplayStage`, `Capabilities`, `Media`/`MediaAsset` (§4.1); `GenerationRequest`, `GenerationResult`, `GenerationProvider`, `Origin` (§4.2); `TrackingEvent`, `GeoPosition`, `ImagesReady`/`ImagesDegraded`, the `gen.*` events, `RealtimeEvent` union (§4.3); `DeviceIdentityRequest`/`Response`, `BearerToken` (§4.4).
- [ ] `@dopamine/contracts` depends on **`zod` only** and imports cleanly in the browser bundle, the NestJS server, and `fake-gen`.
- [ ] Every realtime event schema carries `seq` (int, monotonic) + `ts` (datetime); the SSE framing (`id`/`event`/`data`) matches §4.3 and replays from `Last-Event-ID`.
- [ ] `make sdk` regenerates `packages/sdk/src/openapi.gen.ts` from the committed `/v1` spec and is wired as a **drift gate** in CI (doc 04).
- [ ] `packages/sdk` exports the `ApiClient` interface + `createRestApiClient` + `TrackingClient`, and **every** response method `.parse()`s its body through the matching contracts schema before returning.
- [ ] The `ApiClient` interface is platform-agnostic (`fetch`/`getToken`/EventSource injectable) — verifiably the *same* interface mobile consumes in Stage 6.
- [ ] Money is `{ amount_cents, currency }` everywhere; IDs use the prefixed-ULID convention with the canonical `lst_`/`ord_`/`gen_`/… prefixes; all errors use `ErrorEnvelopeSchema`.
- [ ] Reserved fields (§8.2) are present and typed but verifiably unused in Stage 1 (`embedding === null`, `trackingMode === "timeline"`, `liveLocation === false`, no `geo_position` events emitted).
- [ ] Sibling docs reference THESE definitions: doc 01 emits the spec from them + validates inputs with them; doc 02's `GenerationProvider` impl typechecks against §4.2; doc 03's web client imports the SDK + parses with these schemas; doc 04 runs `make sdk`.
- [ ] `pnpm -r typecheck` passes across the workspace; `contracts → sdk → apps` build order is reflected in `turbo.json`.
```
