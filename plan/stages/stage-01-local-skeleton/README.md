# Stage 01 — Local Walking Skeleton

> **Status:** ✅ **BUILT** — `docker compose` cold-start + the §6 acceptance demo
> (`make e2e`, 13 assertions across all 5 criteria) pass; 136 unit tests. Built
> across milestones M1–M5 (see repo `git log`), each verified and committed, with
> two production-review→fix loops folded in.
> **Goal:** the entire retail product loop, running as Dockerized containers on a
> developer laptop, end-to-end, with **fake** AI generation and **no accounts** —
> a simple but complete web app that lets us *define the features and lock the
> core working set* before we spend a cent on AI or cloud.

This charter is the **shared foundation** every Stage 1 implementation doc builds
on. It fixes the topology, the local tech choices, and the cross-cutting
contracts. The per-workstream docs (`01`–`05` below) go deep inside their slice
without contradicting anything here.

Realizes architecture docs **00** (overview/contracts), **01** (backend/domain),
**03** (client), **04** (tracking) and roadmap **Phase 0–1** — but re-cut as
*local-first with a stubbed generation seam* instead of seeded-data-on-cloud.

---

## 1. What's in scope / out of scope

**In scope (the core working set):**

- Anonymous/device identity only (a `deviceId` → lightweight `user` row). No
  login, no passwords, no email. Every later account attaches to this.
- One vertical: **retail**. The `Vertical` registry exists and is exercised, but
  only `retail` is registered. (This keeps the abstraction honest from day one.)
- Catalog + **search** over Postgres FTS, seeded with a starter catalog.
- **Search-miss → fake generation**: a miss calls the **fake generation
  service**, which returns placeholder listings (deterministic fake text +
  placeholder images) through the *real* `GenerationProvider` contract, persists
  them, and they become first-class catalog items. The blended
  cache-vs-generate grid policy (architecture 02 §4.7) is implemented in a
  simplified form so search returns a populated grid.
- **Cart** (anonymous, one active cart per device) → **checkout** → **order**.
- **Orders** with the per-vertical state machine (retail), idempotent place-order.
- **Fulfillment simulation**: a worker advances orders through the retail
  timeline on accelerated timers and emits tracking events.
- **Live tracking** via **SSE** (timeline mode), with snapshot + replay and a
  polling fallback.
- **Simple web frontend**: search → results grid → listing detail → cart →
  checkout → live timeline tracking. Renders lifecycle **from server data**.
- **Dockerized**: every service is a container; `docker compose up` brings the
  whole system up locally with seed data. Nothing managed/cloud.

**Out of scope (deferred to later stages):**

- Real Claude / real image generation, pgvector semantic dedup, embeddings,
  moderation, eval harness → **Stage 02**.
- Animations, haptics, sound, streaming-token render, blurhash polish →
  **Stage 03** (Stage 1 ships *functional* states: skeleton / placeholder /
  ready, no choreography).
- Real accounts, JWT/OAuth, account upgrade → **Stage 04**.
- Neon/R2/Ably/PaaS/IaC/observability stack → **Stage 05**.
- Mobile → **Stage 06**. Food vertical / geo / maps → **Stage 07**.

---

## 2. Container topology (local docker-compose)

Everything self-hosted in containers — the managed-service equivalents are noted
so Stage 05 is a swap, not a redesign.

```
                         ┌──────────────────────────────────────────────┐
                         │  web  (Next.js)        :3000                  │
                         │  simple retail loop, SSE client              │
                         └───────────────┬──────────────────────────────┘
                                         │ REST /v1 + SSE  (typed SDK)
                                         ▼
        ┌────────────────────────────────────────────────────────────────┐
        │  api  (NestJS modular monolith)         :8080                   │
        │  identity · catalog · search · cart · orders · realtime gateway │
        │  generation-gateway (calls fake-gen over HTTP)                  │
        └───┬───────────────┬───────────────┬───────────────┬────────────┘
            │               │               │               │ enqueue
            ▼               ▼               ▼               ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────────┐
     │ postgres   │  │  redis     │  │  minio     │  │  fake-gen        │
     │  :5432     │  │  :6379     │  │  :9000     │  │  (HTTP svc) :8090│
     │ catalog,   │  │ cache,     │  │ S3-compat  │  │ returns fake     │
     │ orders…    │  │ queue,     │  │ images     │  │ listings+images  │
     │ (FTS)      │  │ pub/sub,   │  │ (→ R2 in   │  │ (→ real pipeline │
     │ (→ Neon)   │  │ lock)      │  │  Stage 05) │  │  in Stage 02)    │
     └────────────┘  └─────┬──────┘  └────────────┘  └──────────────────┘
                           │
                           ▼
                 ┌──────────────────────┐
                 │ worker (BullMQ)      │   same image as api, different entrypoint
                 │ fulfillment sim +    │   advances orders, emits tracking events,
                 │ generation enrichment│   runs the fake "image enrichment" swap
                 └──────────────────────┘
```

**Containers:** `web`, `api`, `worker`, `fake-gen`, `postgres`, `redis`,
`minio` (+ a one-shot `migrate`/`seed` job). The `worker` and `api` share one
Docker image with different entrypoints (one codebase). `fake-gen` is a separate
tiny service *specifically so Stage 02 can replace that one container* with the
real pipeline without touching `api`.

**Local → managed mapping (Stage 05 preview):** postgres→Neon, minio→R2+CDN,
redis→Upstash, in-process/redis SSE fan-out→Ably, fake-gen→real generation
service, docker-compose→Fly/Render + Vercel.

---

## 3. Local tech choices (consistent with architecture, pinned for Stage 1)

| Layer | Stage-1 choice | Notes |
|---|---|---|
| Backend | **NestJS + TypeScript** (Fastify adapter), modular monolith | per arch 01 §2/§7 |
| ORM / migrations | **Prisma** | type-safe, shared types feed the SDK |
| API | **REST + OpenAPI 3.1**, URL-versioned `/v1` | source of truth for the SDK |
| Validation | **Zod** at every boundary | client + server |
| DB | **Postgres 16** (plain container). FTS + `pg_trgm`. **No pgvector yet** | pgvector arrives with semantic dedup in Stage 02 |
| Cache/queue/pubsub/lock | **Redis 7** + **BullMQ** | one container, four jobs |
| Object storage | **MinIO** (S3-compatible) | S3 API now → R2 later, same SDK |
| Realtime | **SSE** from `api`, fanned out via **Redis pub/sub** | `Last-Event-ID` replay; polling fallback |
| State machines | **XState v5** config-as-data, per vertical | retail machine only |
| Fake generation | **standalone HTTP service** implementing `GenerationProvider` | deterministic placeholders |
| Web | **Next.js (App Router) + React + TypeScript + Tailwind** | simple, server-driven rendering |
| SDK | **openapi-typescript / orval**-generated TS client | from the `/v1` spec |
| Monorepo | **pnpm workspaces** (`apps/*`, `packages/*`) | per arch 03 §7 |
| Orchestration | **docker-compose** + a `Makefile`/`task` for DX | `make up`, `make seed`, `make logs` |

---

## 4. Frozen cross-cutting contracts (the seams — do not drift)

These are the load-bearing interfaces. The whole point of Stage 1 is to *pin*
them so later stages and parallel workstreams plug in cleanly. Every impl doc
must conform to these exactly.

### 4.1 Vertical-agnostic order/listing payload (backend ↔ web)
Orders and listings carry **presentation as data**:
- `verticalId` on every listing and order.
- `display.stages[]` — ordered, server-defined lifecycle stages (`{key,label,reached,current}`).
- `display.trackingMode` — `"timeline"` for Stage 1 (`"map"` reserved for food).
- `capabilities.liveLocation` — `false` for retail.
- Clients **never hardcode** state enums; they render from `display.stages`.

### 4.2 Generation contract (backend ↔ fake-gen, identical to the real one)
The fake service implements the architecture's `GenerationProvider` (arch 02 §8.1):
- **Request:** `{ query, vertical, deviceId, locale?, requestId }`.
- **Fast-path response:** `{ listing_id, generation_id, origin, status, listing{…, media} }`
  where `media.status ∈ {generating_text, generating_media, ready, degraded}`
  and `origin ∈ {exact_cache, semantic_reuse, seed, generated}`.
- **Async event:** `images.ready` / `images.degraded` keyed on `generation_id`,
  carrying a thin `media` block for the client to swap in.
- Stage 1 fakes the *content* (placeholder text + a generated SVG/solid-color
  placeholder image in MinIO) but honors **every field and state transition** so
  Stage 02 is a drop-in. Backend still owns canonicalization, the exact-cache
  (Redis `canon_key → listing_id`), the generation lock, idempotency, image
  ingestion to MinIO, and the transactional catalog write — fake-gen only
  "produces content."

### 4.3 Realtime event contract (realtime ↔ web)
- Channel `order:{orderId}` carries `tracking_event` (state changes).
- Generation swaps ride the same fan-out: `images.ready`/`images.degraded` keyed
  on `generation_id`.
- Every event carries a **per-order monotonic `seq`** and server `ts`. Client
  rules: apply in `seq` order, drop `seq <= lastApplied`, catch up on reconnect
  via snapshot (`GET /v1/orders/{id}/tracking`) + replay from `seq`.
- SSE transport with `Last-Event-ID`; **polling `GET /v1/orders/{id}`** is the
  always-available fallback.

### 4.4 Identity (anonymous-first)
- `POST /v1/identity/device` (or an `X-Device-Id` header bootstrap) issues/looks
  up an anonymous `user` keyed on `deviceId`. A short-lived bearer token scopes
  requests. **Same bearer scheme** that Stage 04 will issue real accounts under —
  so account upgrade is "swap the token issuer," not a re-plumb.

---

## 5. Workstreams & the implementation docs (the agent team)

Stage 1 is built by five parallel workstreams. Each owns one implementation doc
in this folder. They build against §2–§4 above, so they compose without
contradiction.

| Doc | Workstream | Owns |
|---|---|---|
| [`01-backend-api.md`](01-backend-api.md) | **Backend / domain** | NestJS modules (identity, catalog, search, cart, orders, vertical registry, generation gateway), Prisma schema + migrations + seed, OpenAPI `/v1`, the search→miss→generate→persist seam wiring, idempotency, the blended grid policy (simplified). |
| [`02-fake-generation.md`](02-fake-generation.md) | **Fake AI generation** | The `fake-gen` service: the `GenerationProvider` contract, deterministic placeholder listing text, placeholder image generation into MinIO, fake multi-listing grid fill, fake media-state progression (`generating_media`→`ready`) and the `images.ready` event — all swappable for Stage 02. |
| [`03-web-frontend.md`](03-web-frontend.md) | **Web client** | Next.js app: the full loop (search → grid → listing → cart → checkout → timeline), data-driven rendering from `display.stages`, SSE tracking client + polling fallback, functional generation states, the feature inventory / "core working set" this stage exists to define. |
| [`04-docker-infra.md`](04-docker-infra.md) | **Infra / DX** | docker-compose for all containers, the shared api/worker image, MinIO + Redis + Postgres wiring, healthchecks, the migrate/seed one-shot, `.env` strategy, `Makefile`/task DX, BullMQ worker entrypoint, local→managed mapping notes for Stage 05. |
| [`05-contracts-and-sdk.md`](05-contracts-and-sdk.md) | **Shared contracts / SDK** | The pnpm monorepo layout, the shared `packages/contracts` (Zod + generated OpenAPI types), the typed API SDK consumed by web, the realtime event type definitions, and the canonical TypeScript shapes for §4's contracts so every other doc references one source of truth. |

---

## 5.5 Cross-doc reconciliations (canonical resolutions)

The five docs were authored in parallel and each resolved a couple of boundary
ambiguities. These are the **binding** resolutions where they touched the same
seam — implement to these:

1. **Correlation key = `generationId`** (not `client_ref`). Every async swap and
   generation event is keyed on `generationId`. `fake-gen` returns
   `listing_id: null` (the **backend mints listing ids** during the
   transactional persist) and the `generationId` is what threads request →
   persist → `images.ready` → client swap.
2. **Async media swap is worker-driven, not webhook.** `fake-gen` only produces
   content; the **worker** runs the `generation.enrich` BullMQ job, pulls the
   final images from `fake-gen` (`GET /media/:generationId`), **ingests bytes to
   MinIO** (image ingestion is the backend's job, mirroring the real pipeline),
   then writes `listing.media=ready` + an `images.ready` outbox event that
   fans out over SSE. No provider ever writes our bucket. (Stage 02's real
   provider's webhook terminates at the worker the same way.)
3. **Retail state-machine spelling** is the doc-04 set:
   `placed→confirmed→packed→shipped→out_for_delivery→delivered` (+ `cancelled`).
   Clients render it from `display.stages` regardless, but the simulation and
   seed use this spelling.
4. **SDK tooling** = `openapi-typescript` for generated transport types + a thin
   hand-written `ApiClient` interface/impl; `packages/contracts` Zod schemas are
   the runtime boundary validators on both client and server. (orval/hey-api are
   insulated alternatives behind the `ApiClient` interface.)
5. **`fake-gen` is a pure content function.** Canonicalization, exact-cache, the
   generation lock, dedup, idempotency, persistence, and image ingestion all
   live in the **backend**; `fake-gen` returns `origin: "generated"` content only
   (cache/seed/reuse hits mean the backend never calls it).

6. **`fake-gen` HTTP contract (as built — the api/worker integrate against THIS,
   not doc 01/02 prose).** The canonical `@dopamine/contracts` schemas won over
   the docs' illustrative JSON wherever they differed. Concretely:
   - `POST /generate` → a single `GenerationResult` (`listing_id: null`,
     `origin: "generated"`, `status: "generating_media"`, `listing` with a
     placeholder hero whose `MediaAsset.url` is a **fetchable** `fake-gen` URL
     `http://fake-gen:8090/img/ph/<key>.svg`).
   - `POST /generate-grid` → an **envelope** `{ generation_id, origin, status,
     results: GenerationResult[] }` (the array rides the envelope; each element
     is a contract `GenerationResult`). The api's generation-gateway adapter maps
     this HTTP envelope onto the `GenerationProvider.generateGrid` interface
     (`Promise<GenerationResult[]>`).
   - `GET /media/:generationId` → the **worker's** async-readiness poll
     (worker-driven, not webhook): `generating_media` until the fake enrichment
     delay elapses, then `ready` with final `…/img/fin/<key>.svg` heroes. The
     worker GETs those URLs and **ingests the bytes to MinIO** (fake-gen never
     writes MinIO). `<key>` is content-addressed so MinIO writes are idempotent.
   - `generation_id` granularity: one **batch** id per request (deterministic
     from `requestId|vertical|query`); each variant also carries a per-listing
     `<batch>:g<n>` in its `media.generation_id`. The worker polls the **batch**
     id and receives all items.
   - Price is `Money` (`{ amount_cents, currency }`); `category`, `bullet_specs`,
     and spec facets ride in the listing's open `attributes` JSONB (no
     `amount_min/max`, `image_prompts`, or `client_ref` top-level fields exist).
   - Env knobs on `fake-gen`: text latency, image-enrichment delay, forced-degraded
     rate, grid size — for demoing skeleton→placeholder→ready and the degraded path.

7. **The `worker` exposes a tiny `/healthz`** so its container healthcheck is a
   real readiness probe (can it reach Redis/BullMQ), not a liveness placeholder.

8. **Zod v4** is in use across the workspace — downstream code uses v4 idioms
   (`z.url()`, `z.iso.datetime()`, `z.record(z.string(), z.unknown())`); identical
   wire shapes to the v3 snippets in the docs.

---

## 6. Stage exit criteria (the acceptance demo)

Stage 1 is **done** when, from a clean checkout, `make up && make seed` brings up
all containers and a reviewer can, in a browser against `localhost`:

1. **Browse** the seeded retail catalog and open a listing detail.
2. **Search a brand-new term** never searched before (e.g. "a ladder") → see a
   skeleton/placeholder grid appear **instantly**, then watch placeholder
   listings + images materialize via the fake pipeline, then re-search the same
   term and get an **instant cache hit**.
3. **Add to cart**, adjust quantity, and **check out** as an anonymous device
   user (no login).
4. **Place an order** (idempotent) and watch the **retail timeline advance live**
   via SSE through the full state machine to `delivered`; reload mid-flight and
   the tracking **resyncs** from snapshot+replay; kill the SSE connection and the
   **polling fallback** keeps it current.
5. Every lifecycle stage shown in the UI comes **from `display.stages`**, not
   hardcoded — verified by the fact the client has no retail state enum.

Plus each impl doc's own exit checklist passes, and the system runs with **zero
real external API keys** (no Anthropic, no cloud creds) — proving the fakes and
local stack are self-contained.
