# `@dopamine/fake-gen` — Stage 1 fake generation service

A tiny, stateless HTTP service (port **8090**) that implements the **content
surface** of the `GenerationProvider` contract (`@dopamine/contracts`) with
deterministic placeholder content, **zero AI cost, and no API keys**.

It is a **pure content function** (charter §5.5.5): `(query, vertical, count) →
fake content`. It does **no** canonicalization, caching, locking, id-minting,
persistence, MinIO writes, or SSE fan-out — all of that lives in `api`/`worker`.
The HTTP boundary *is* the seam: Stage 2 replaces this one container with the
real Claude + image pipeline **without `api` changing a line**.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/generate` | Fast path. Returns `{ generation_id, origin, status, results[] }` — each `results[i]` is a contract `GenerationResult` (`listing_id: null`, `origin: "generated"`, `status: "generating_media"`, placeholder hero). `count` (optional) fills the grid. |
| `POST` | `/generate-grid` | Same as `/generate` but `count` is **required** (the `generateGrid` provider method). |
| `GET`  | `/media/:generationId` | Worker-driven readiness poll (charter §5.5.2). Returns `{ generation_id, outcome, items[] }`; each item carries a contract `Media` block. `outcome ∈ generating_media \| ready \| degraded`. |
| `GET`  | `/img/:dir/:key.svg` | Deterministic placeholder/final SVG **bytes** the worker fetches and ingests. `dir = ph` (placeholder) \| `fin` (final). |
| `GET`  | `/generate/stream` | Optional COLD token stream (SSE) emitting `gen.start` / `gen.text.delta` / `gen.field_done` / `gen.text.done`. |
| `GET`  | `/healthz` | Liveness for the compose healthcheck. |

All request/response bodies are validated against `@dopamine/contracts` Zod
schemas at runtime, so any contract drift fails loudly.

## Image representation & how the worker ingests it (charter §5.5.2)

fake-gen returns **fetchable image URLs**, mirroring a real image provider — it
**never writes MinIO**. The flow:

1. `POST /generate` → each listing's `media.hero.url` is
   `http://fake-gen:8090/img/ph/<key>.svg` (a deterministic SVG). The worker
   fetches that URL, ingests the bytes to MinIO, and persists the **MinIO** URL.
2. After `FAKE_MEDIA_DELAY_MS`, the worker's delayed BullMQ job calls
   `GET /media/:generationId`. The final heroes are `…/img/fin/<key>.svg`.
   The worker fetches, ingests to MinIO, flips `media.status = ready`, and
   publishes `images.ready` keyed on `generation_id`.

`<key>` is content-addressed (`sha256(kind|query|variant|slot)`), so the URL —
and therefore the worker's content-addressed MinIO key — is **stable and
idempotent to re-ingest**.

**Why fetchable URLs (not base64 inline, not a MinIO write):** it is the exact
shape a real image provider returns (bytes behind a URL the backend fetches),
keeps ingestion in `api`/`worker` where the charter puts it, and keeps fake-gen
credential-free. Base64-inline was rejected: it bloats the JSON, and the real
provider does not inline bytes — so inlining would make Stage 2 a bigger change.

## Configuration (env)

| Env var | Default | Effect |
|---|---|---|
| `FAKE_GEN_PORT` | `8090` | Listen port. |
| `FAKE_GEN_HOST` | `0.0.0.0` | Bind host. |
| `FAKE_GEN_PUBLIC_BASE_URL` | `http://fake-gen:8090` | Base URL used to build the fetchable `/img/...` URLs. |
| `FAKE_TEXT_DELAY_MS` | `0` | Artificial delay before `POST /generate` responds. |
| `FAKE_MEDIA_DELAY_MS` | `1500` | Delay before final media becomes available (drives `expected_ready_ms`). |
| `FAKE_MEDIA_MODE` | `twophase` | `twophase` (placeholder → async ready) or `inline` (ready immediately). |
| `FAKE_FAILURE_RATE` | `0` | Probability (0..1) a generation resolves `degraded`. **Deterministic per generation.** `1` forces degraded. |
| `FAKE_STREAM` | `0` | Reserved flag for the COLD stream (the `/generate/stream` endpoint is always available). |
| `FAKE_STREAM_DELTA_MS` | `60` | Per-chunk cadence for the token stream. |
| `FAKE_FAIL_GENERATE` | `0` | `1` makes `POST /generate` return the `generation_failed` error envelope. |
| `FAKE_DEFAULT_COUNT` | `1` | `count` used when the caller omits it. |
| `FAKE_GRID_MAX` | `24` | Upper bound honored for `count`. |
| `LOG_LEVEL` | `info` | Fastify log level. |

## What Stage 2 replaces (proving the seam)

Localized to this one container (`src/generator.ts` + `src/images.ts`):

| Stage 1 (fake) | Stage 2 (real) |
|---|---|
| `fakeListingText()` templated text from a seeded hash (`src/generator.ts`) | Claude structured-output call. |
| Deterministic SVG placeholder/final bytes (`src/images.ts`) | Flux Schnell placeholder + gpt-image-1.5 final. |
| Title-collision de-dupe in `buildBatch` | embedding de-dupe before persist. |
| `FAKE_MEDIA_DELAY_MS` timer → `GET /media` | real image-provider webhook terminating at the worker. |
| `FAKE_FAILURE_RATE` deterministic degrade | real retry/timeout exhaustion → `degraded`. |
| `gen.*` events sliced from finished strings (`src/service.ts`) | streaming `messages.create` deltas. |

**Unchanged across stages (the seam):** the HTTP contract (`/generate`
request/response, the `media` states, the `origin` union, the `images.ready` /
`images.degraded` shapes, the error envelope), the `api`/`worker` boundary
(canonicalization, exact-cache, generation lock, idempotency, image ingestion to
MinIO, the catalog write, the realtime fan-out), and the container topology
(same port, same place in compose).
