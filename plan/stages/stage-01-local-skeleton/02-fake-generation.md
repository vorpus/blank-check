# 02 — Fake Generation (Stage 1)

> **Owner:** Fake AI Generation
> **Status:** Stage 1 implementation — current build target.
> **Scope:** The `fake-gen` standalone HTTP service (container, port `8090`) that
> implements the **real** `GenerationProvider` contract (architecture
> [`02-ai-generation-pipeline.md`](../../../docs/architecture/02-ai-generation-pipeline.md)
> §8) but returns deterministic placeholder content with **zero AI cost and no
> API keys**. The point of this service is the *seam*: it honors every field,
> status, and event of the real contract so Stage 2 swaps this one container for
> the real pipeline **without `api` changing a line**.
> **Date:** 2026-06-21

Realizes charter §4.2 (generation contract), §4.3 (realtime event contract) of
[`README.md`](./README.md), and fakes architecture **02** §1.4 (media states),
§4.7 (multi-listing), §8 (interface contract).

Sibling docs (one source of truth each — referenced, not duplicated here):

- [`01-backend-api.md`](./01-backend-api.md) — the **generation-gateway** that
  calls this service, and owns canonicalization, the exact-cache, the generation
  lock, idempotency, image ingestion to MinIO, the transactional catalog write,
  and the blended grid policy. **fake-gen produces content; api does everything
  else.**
- [`05-contracts-and-sdk.md`](./05-contracts-and-sdk.md) — the canonical
  Zod/TypeScript shapes for the request, the response, and the `images.ready` /
  `images.degraded` events. This doc shows the shapes inline for readability but
  **05 owns the types**; `fake-gen` imports them.
- [`04-docker-infra.md`](./04-docker-infra.md) — the `fake-gen` container, its
  env, healthcheck, and the MinIO/Redis wiring.
- [`03-web-frontend.md`](./03-web-frontend.md) — the client that renders the
  media states and swaps on the async event.

---

## 1. What this service is (and is not)

`fake-gen` is a tiny, stateless HTTP service. It implements exactly one job from
the real pipeline: **"produce content for a query."** It is the Stage 1 stand-in
for architecture 02's `GenerationService` — but *only* the content-production
core of it. Everything that makes generation a *system* (dedup, locks,
persistence, ingestion) is **not** here; it lives in `api`.

### 1.1 The boundary — what fake-gen returns vs. what `api` does

This is the single most important section. Charter §4.2 is explicit: the backend
owns canonicalization, the exact-cache (`canon_key → listing_id`), the generation
lock, idempotency, **image ingestion to MinIO**, and the transactional catalog
write. `fake-gen` *only produces content*.

| Concern | Owner | Notes |
|---|---|---|
| Normalize query → `canon_key` | **api** | `fake-gen` receives the already-normalized `query`; it must not re-normalize for any purpose other than its own deterministic seed. |
| Exact cache (`canon_key → listing_id`) | **api** | `fake-gen` never sees Redis. If api gets a cache hit it **never calls `fake-gen`**. |
| Semantic dedup / `pgvector` | **api** (Stage 2) | Not present in Stage 1 (no pgvector). api decides `origin`. |
| Generation lock (thundering herd) | **api** | api holds the `SET NX PX` lock around the `fake-gen` call. |
| Idempotency on `request_id` | **api** | api dedupes; `fake-gen` may be called more than once and must return identically (it's deterministic — see §3). |
| Blended grid policy / regimes (§4.7) | **api** | api decides **how many** listings to ask for; `fake-gen` just honors `count`. |
| **Calling `fake-gen`** | **api** | Over HTTP, port `8090`. |
| Producing listing **text** (title/desc/category/specs/attributes/price) | **fake-gen** | Deterministic from `query`. §3. |
| Producing **image bytes + prompts + blurhash** | **fake-gen** | Returns *bytes/URLs to fetch*, not a MinIO write. §5. |
| **Ingesting images to MinIO** | **api** (+ worker) | api takes the bytes from `fake-gen` and PUTs to MinIO, mints the final URL it persists. §5.3. |
| Persisting the listing (catalog write) | **api** | Transactional, in Postgres. |
| Emitting `images.ready` over SSE | **api** realtime gateway | `fake-gen` *signals readiness*; api fans it out. §6. |

**One-line mental model:** `fake-gen` is a pure function
`(query, vertical, count) → fake content`. `api` is the stateful machine that
wraps caching, locking, persistence, and delivery around it. The wrapper is
identical in Stage 1 and Stage 2; only the function inside changes.

### 1.2 Why a separate container at all

Per charter §2: `fake-gen` is its own tiny service "specifically so Stage 02 can
replace that one container with the real pipeline without touching `api`." If we
inlined the fakes into `api`, Stage 2 would be a refactor of `api` instead of a
container swap. The HTTP boundary *is* the seam. See §9.

---

## 2. HTTP API

Tiny service. Node + Fastify (or any HTTP server — it's behind an interface). All
bodies are JSON except image bytes. All shapes conform to architecture 02 §8 and
are validated with the Zod schemas from [`05-contracts-and-sdk.md`](./05-contracts-and-sdk.md).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/generate` | Fast-path: produce 1..N fake listings for a query (§2.1). |
| `GET` | `/media/:generationId` | Poll for / fetch the **final** (enriched) media for a generation once the fake delay elapses (§2.2, §6). |
| `GET` | `/healthz` | Liveness for the compose healthcheck (§8). |

`fake-gen` is **stateless across restarts for content** (everything is
re-derivable from `query` — §3), but it holds a small **in-memory schedule** of
pending enrichments (generation_id → "final media ready at T") so it can answer
`GET /media/:generationId` and the readiness signal. Losing that on restart is
harmless: api falls back to the placeholder and the worst case is `degraded`.

### 2.1 `POST /generate` — the fast path

**Request** (architecture 02 §8.1 shape; `api` sends the already-normalized query):

```jsonc
// POST http://fake-gen:8090/generate
{
  "query": "ladder",          // already normalized by api (canon form)
  "vertical": "retail",       // only "retail" registered in Stage 1
  "user_id": "usr_01H...",    // pass-through; fake-gen ignores it for content
  "locale": "en-US",          // optional
  "request_id": "req_01H...", // tracing/idempotency (api owns idempotency)
  "count": 8                  // NEW: how many distinct listings to produce (§4)
                              // api derives this from the §4.7 regime; default 1
}
```

> **`count`** is the one addition over the real §8.1 request, and it is *already*
> implied by architecture 02 §4.7's multi-listing ("one Claude call produces a set
> of N distinct variants … an array of the §2.2 schema"). The real pipeline takes
> the same parameter; we surface it explicitly so the Stage 1 grid can be filled.
> Stage 2's real `generate` honors `count` identically — no contract drift.

**Response (fast path)** — an envelope plus an **array** of listings. For
`count == 1` the array has one element; this is the same shape the real
multi-listing path returns, so api has one code path.

```jsonc
{
  "generation_id": "gen_01H...",   // one id per generate call; correlates the swap
  "origin": "generated",           // fake-gen ALWAYS returns "generated" — see note
  "status": "generating_media",    // batch-level status; "ready" only if media inline
  "listings": [
    {
      "listing_id": null,          // fake-gen does NOT mint ids — api does on persist
      "client_ref": "g0",          // stable within-batch handle so api can correlate
                                   //   the per-listing media event after persist
      "listing": {
        "title": "ProReach 16 ft Aluminum Extension Ladder",
        "description": "Reach new heights with the ProReach 16 ft ...",
        "category": "Tools > Ladders",
        "bullet_specs": ["300 lb load rating", "Slip-resistant feet", "..."],
        "attributes": [
          { "key": "Material", "value": "Aluminum" },
          { "key": "Max Height", "value": "16 ft" }
        ],
        "price": { "currency": "USD", "amount_min": 119, "amount_max": 149 },
        "media": {
          "status": "generating_media",
          "hero": {
            "kind": "placeholder",
            "blurhash": "LKO2:N%2Tw=w]~RBVZRi",
            "aspect_ratio": "1:1",
            "source": {                 // api ingests THIS to MinIO (§5.3)
              "ingest": "fetch",
              "url": "http://fake-gen:8090/img/ph/<imgkey>.svg"
            }
          },
          "alternates": [],
          "expected_ready_ms": 1500,    // honest fake hint (matches FAKE_MEDIA_DELAY_MS)
          "generation_id": "gen_01H..."
        },
        "image_prompts": {              // pass-through; Stage 2 image model consumes these
          "hero": "studio product photo of a 16ft aluminum extension ladder ...",
          "alternates": ["close-up of the ladder rung detail ..."],
          "style_tokens": ["aluminum", "industrial", "studio lighting"]
        }
      }
    }
    // ... count-1 more distinct variants (§4)
  ]
}
```

**Notes on the boundary, made concrete:**

- **`origin` is always `"generated"` from `fake-gen`.** `origin ∈ {exact_cache,
  semantic_reuse, seed, generated}` is **api's** decision, not fake-gen's —
  because exact-cache and semantic-reuse hits mean api **never calls** fake-gen.
  Seed listings come from the seed job. fake-gen is only ever invoked on a true
  miss, so the only origin it can author is `generated`. api stamps the final
  `origin` on the response it returns to the client. (We keep the field on the
  fake-gen response anyway, so the wire shape matches §8.1 exactly and Stage 2 — a
  pipeline that *could* internally short-circuit — is a drop-in.)
- **`listing_id` is `null`.** Architecture 02 §8.1 shows a `listing_id` because in
  the real doc the pipeline is imagined as co-owning persistence. Charter §4.2
  **overrides** that for our split: the backend owns the transactional catalog
  write and therefore mints the id. fake-gen returns `client_ref` (a stable
  within-batch label, `g0..gN`) so that *after* api persists and assigns real ids,
  api can map each later media event back to the right `listing_id`. api keeps a
  `generation_id + client_ref → listing_id` map. (Stage 2's real pipeline, which
  also doesn't own persistence under this charter, behaves the same way.)
- **`status` may be `ready`** when `FAKE_MEDIA_MODE=inline` (§7) — then `media`
  carries a `final` hero immediately and no async event follows. The default is
  the two-phase `generating_media` path so the client exercises the swap.

### 2.2 `GET /media/:generationId` — fetch enriched media

After the fake enrichment delay (§7), the "final" placeholder is ready. api (its
worker) learns about this in one of two equivalent ways — **pick the one
`01-backend-api.md` implements; both are contract-accurate**:

- **(A) fake-gen pushes** — on `POST /generate`, fake-gen schedules a fire-and-
  forget HTTP callback to `api` (`POST {API_INTERNAL_URL}/internal/generation/
  images-ready`) after `FAKE_MEDIA_DELAY_MS`. This mirrors the real image
  provider's **webhook** (architecture 02 §3.4: "use the provider's webhook
  callback so a worker isn't blocked").
- **(B) api/worker polls** — api enqueues a BullMQ **delayed job** (delay =
  `expected_ready_ms`) that calls `GET /media/:generationId`. This mirrors the
  real worker enqueuing enrichment (architecture 02 §1.3 step "enqueue
  enrichment"). It is also more robust to fake-gen restarts.

> **Recommendation: (B) the delayed-job poll**, because it keeps **all** retry /
> idempotency / persistence logic inside `api`/`worker` (where it already lives for
> order fulfillment), and matches charter §2's note that the `worker` "runs the
> fake image enrichment swap." fake-gen stays a pure content function with no
> outbound dependency on api. `GET /media` returns:

```jsonc
// GET http://fake-gen:8090/media/gen_01H...
{
  "generation_id": "gen_01H...",
  "outcome": "ready",                 // "ready" | "degraded"  (see FAKE_FAILURE_RATE §7)
  "items": [
    {
      "client_ref": "g0",
      "media": {
        "status": "ready",
        "hero": {
          "kind": "final",
          "blurhash": "L6PZfSjE.AyE_3t7t7R**0o#DgR4",
          "aspect_ratio": "1:1",
          "source": { "ingest": "fetch", "url": "http://fake-gen:8090/img/fin/<imgkey>.svg" }
        },
        "alternates": [
          { "kind": "final", "blurhash": "...", "aspect_ratio": "1:1",
            "source": { "ingest": "fetch", "url": "http://fake-gen:8090/img/fin/<imgkey>-a1.svg" } }
        ]
      }
    }
    // ... one per client_ref in the batch
  ]
}
```

If the simulated outcome is `degraded` (§7), `outcome: "degraded"` and each item's
`media.status = "degraded"` with the hero **left as the placeholder** (architecture
02 §1.4 rule 4: the listing stays fully usable; never an error).

api then: fetches each `source.url`, PUTs the bytes to MinIO, persists the final
URL on the listing, flips `status`, and fans out `images.ready` / `images.degraded`
on the realtime channel keyed on `generation_id` (§6).

### 2.3 Errors

Same error envelope as architecture 02 §8.1, so api's error handling is
Stage-2-ready:

```jsonc
{ "error": { "type": "generation_failed", "message": "...", "retryable": true } }
```

Stage 1 fake-gen can only realistically emit `generation_failed` (when
`FAKE_FAIL_GENERATE=1` is set for testing the path). `moderation_blocked`,
`rate_limited`, and `budget_exhausted` are **api-side** concerns in both stages
(charter §4.2: api owns rate/budget; moderation is Stage 2) — fake-gen never
emits them. We keep the type union intact in the shared contract regardless.

---

## 3. Deterministic fake listing text

**Requirement:** the same query yields the *same* fake listing forever, so demos
are reproducible and a re-search (before api's cache is warm, or across a DB
reset) is stable. We get this with a **seeded hash → templated content**
generator. No randomness, no clock, no AI.

### 3.1 The seed

```ts
import { createHash } from "node:crypto";

// api already normalized `query`; we hash the (query, vertical, variantIndex)
// triple so each of the N multi-listing variants is distinct but still deterministic.
function seed(query: string, vertical: string, variant: number): number {
  const h = createHash("sha256")
    .update(`${vertical}::${query}::${variant}`)
    .digest();
  // 32-bit unsigned seed from the first 4 bytes
  return h.readUInt32BE(0);
}

// A tiny deterministic PRNG (mulberry32) so we can draw many stable values from one seed.
function rng(s: number): () => number {
  let a = s >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
```

### 3.2 Templated content

A small set of word banks + templates per vertical. The query becomes the
**noun** of the product; everything else is drawn deterministically from the
seeded PRNG. Output conforms to the architecture 02 §2.2 retail schema (title,
description, category, bullet_specs, attributes, price, image_prompts).

```ts
const BRANDS    = ["ProReach", "Acme", "NorthPeak", "EverBuild", "Vantage", "Koto", "Brightline"] as const;
const MATERIALS = ["Aluminum", "Steel", "Bamboo", "Recycled Plastic", "Carbon Fiber", "Oak"] as const;
const QUALIFIERS= ["Heavy-Duty", "Compact", "Premium", "Eco", "Pro-Grade", "Everyday"] as const;
const STYLE     = ["industrial", "minimalist", "rustic", "modern", "matte"] as const;

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function fakeListing(query: string, vertical: string, variant: number) {
  const r = rng(seed(query, vertical, variant));
  const brand     = pick(r, BRANDS);
  const material  = pick(r, MATERIALS);
  const qualifier = pick(r, QUALIFIERS);
  const style     = pick(r, STYLE);
  const noun      = titleCase(query);

  // price: deterministic band derived from the seed, in a plausible retail range
  const base = 15 + Math.floor(r() * 285);        // $15–$300
  const min  = base;
  const max  = base + 10 + Math.floor(r() * 40);  // small spread

  return {
    title: `${brand} ${qualifier} ${material} ${noun}`.slice(0, 80),
    description:
      `Meet the ${brand} ${qualifier} ${noun}. Built from ${material.toLowerCase()} for a ` +
      `${style} look that lasts, it's the ${noun.toLowerCase()} a simulated shopper actually wants. ` +
      `Every detail is fictional — and proud of it.`,
    category: `${titleCase(vertical)} > ${noun}s`,            // simplified single category
    bullet_specs: [
      `${material} construction`,
      `${qualifier} build quality`,
      `${style} finish`,
      `Fits the way you fake-shop`,
    ],
    attributes: [
      { key: "Brand",    value: brand },
      { key: "Material", value: material },
      { key: "Style",    value: style },
    ],
    price: { currency: "USD", amount_min: min, amount_max: max },
    image_prompts: {
      hero: `studio product photo of a ${material.toLowerCase()} ${query}, ${style}, neutral background`,
      alternates: [`close-up detail of a ${material.toLowerCase()} ${query}`],
      style_tokens: [material.toLowerCase(), style, "studio lighting"],
    },
  };
}
```

**Properties this gives us:**

- **Reproducible:** `fakeListing("ladder", "retail", 0)` is byte-identical on every
  call, every container, forever. Demos and tests are stable.
- **Plausible-but-obviously-fake:** the description winks at being fictional
  (matches architecture 02's "everything is fake" framing) while still reading like
  a real card.
- **Schema-faithful:** identical field set to the real §2.2 output, so api's
  persistence mapping is unchanged in Stage 2.

---

## 4. Fake multi-listing generation (filling the grid)

Architecture 02 §4.7 says a search page should look like a store — a grid of
*distinct* products — and that the real pipeline returns "a set of N distinct
variants … brands, materials, price points" in one structured response. We fake
exactly that, simply: **vary `variant` from `0..count-1`** and the seed in §3.1
makes each one distinct (different brand/material/price) while keeping the whole
batch deterministic for the query.

```ts
function fakeBatch(query: string, vertical: string, count: number) {
  return Array.from({ length: count }, (_, variant) => {
    const listing = fakeListing(query, vertical, variant);
    return { client_ref: `g${variant}`, listing_id: null, listing };
  });
}
```

- **Distinctness** comes free from the per-variant seed; we additionally guard
  against an accidental title collision by re-rolling `variant` deterministically
  (e.g. `variant + count`) if two titles match — cheap and still reproducible.
  (The real pipeline de-dupes by embedding before persist; we de-dupe by title,
  the Stage-1 equivalent.)
- **`count` is api's call**, derived from the §4.7 regime (HOT → api fills from
  cache, calls fake-gen with small/zero count; WARM → `count = gridTarget −
  matchCount`; COLD → `count = K`, e.g. 8). fake-gen just honors the number.
  Budget governance (architecture 02 §5) is api's; fake-gen has no budget.
- **Images:** only the first card (`g0`) is the "focused" one in COLD (it gets the
  optional streaming path, §5/§5.4); all cards get a placeholder hero immediately.
  Architecture 02 §4.7 notes off-screen heroes lazy-enrich — Stage 1 keeps it
  simple and enriches the whole batch on one delayed job, but the per-card media
  shape supports lazy enrichment unchanged.

---

## 5. Placeholder images

### 5.1 What we generate

A **deterministic SVG** per image: a solid/gradient background whose color is
derived from the seed, plus the query text and a small "FAKE" watermark.
SVG is ideal for Stage 1: it's tiny, text-based, requires no image libraries, and
is fully deterministic. We compute a **blurhash** for it so the client's
blurhash-first render (architecture 02 §1.4 rule 2) works identically to the real
path.

```ts
function svgPlaceholder(query: string, variant: number, kind: "placeholder" | "final"): string {
  const r = rng(seed(query, "img", variant));
  const hue = Math.floor(r() * 360);
  const bg  = `hsl(${hue} 45% ${kind === "final" ? 62 : 80}%)`;   // final = richer/darker
  const fg  = `hsl(${hue} 60% 20%)`;
  const tag = kind === "final" ? "" : "generating…";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <rect width="1024" height="1024" fill="${bg}"/>
    <text x="512" y="512" font-family="sans-serif" font-size="64" font-weight="700"
          fill="${fg}" text-anchor="middle" dominant-baseline="middle">${escapeXml(query)}</text>
    <text x="512" y="600" font-family="sans-serif" font-size="28"
          fill="${fg}" opacity="0.7" text-anchor="middle">${tag} · FAKE</text>
  </svg>`;
}
```

The **placeholder** (rule: low-fi, "Enhancing photos…" shimmer) and the **final**
(richer color, no "generating" tag) are visibly different so the swap is obvious
in a demo. Both are deterministic from the seed → the same query always renders
the same images.

### 5.2 Blurhash

We precompute a blurhash from the dominant color of the SVG (a single rasterized
8×8 is enough; or, since the SVG is a flat field, derive a blurhash directly from
the chosen `hue` with a tiny lookup). The blurhash rides on `media.hero.blurhash`
exactly as architecture 02 §1.4 / §8.2 specify, so the client renders the blurred
preview instantly.

### 5.3 Who writes to MinIO — and why

**fake-gen returns image *bytes/URLs*; `api` ingests them to MinIO.** This is a
deliberate choice and it is the one that mirrors the real pipeline:

- Charter §4.2 states the backend owns **image ingestion to MinIO**. Architecture
  00 §3.2 / §4.2 and 02 §9 (Backend/domain row) state "the backend owns … **image
  ingestion**." The real image provider (gpt-image-1.5) returns bytes via webhook;
  the backend transcodes → webp, computes blurhash, strips EXIF, and writes to
  object storage (architecture 02 §3.4). fake-gen occupies the *provider* slot in
  that picture, and a provider **does not write to our bucket** — it hands us
  bytes.
- So fake-gen exposes the bytes at `GET /img/ph/<imgkey>.svg` (placeholder) and
  `GET /img/fin/<imgkey>.svg` (final). The `media.hero.source` block tells api
  `{ ingest: "fetch", url }`. api fetches, PUTs to MinIO under a content-addressed
  key, and persists the **MinIO** URL on the listing. The client only ever sees
  api/MinIO URLs, never `fake-gen` URLs.
- **Why not let fake-gen write MinIO directly?** It would (a) give fake-gen a
  dependency and credentials it shouldn't have, (b) move ingestion out of api,
  contradicting the charter, and (c) make Stage 2 a *bigger* swap (the real
  provider can't write our bucket). Returning bytes keeps fake-gen a pure content
  producer and keeps the ingestion code in api identical across stages.

`imgkey` is deterministic (`hash(query|variant|kind)`) so image URLs are stable
and api's content-addressed MinIO key is stable too — re-ingesting is idempotent.

### 5.4 Two-phase media progression

This is the core UX contract (architecture 02 §1.4). fake-gen drives it:

1. **`POST /generate` returns immediately** with `media.status =
   "generating_media"` and a **placeholder** hero (`kind: "placeholder"`). api
   ingests the placeholder to MinIO, persists the listing in `generating_media`,
   returns it to the client → client shows the card with a placeholder + shimmer.
2. **After `FAKE_MEDIA_DELAY_MS`** (§7), the "final" media is available via
   `GET /media/:generationId` (or the push callback). api ingests the **final**
   images, flips `status = "ready"`, and fans out `images.ready` (§6) → client
   cross-fades placeholder → final, no re-mount.

`generating_text → generating_media → ready` is the full escalation
(architecture 02 §1.4). The `generating_text` step is the **optional COLD stream**,
§5.5 / §6 below; without it, the fast path starts at `generating_media` (which is
the architecture's "reuse/cache" entry point — and exactly what charter §1's
"skeleton / placeholder / ready" functional states require).

---

## 6. Fake streaming (optional COLD path) + the async media event

### 6.1 The token stream (optional, off by default in Stage 1)

Architecture 02 §1.4 "COLD path" streams Claude's tokens **field-by-field** so the
user watches the listing type itself out, with these events on a channel keyed on
`generation_id`:

```jsonc
{ "type": "gen.start",      "fields": ["title","description","specs"], "client_ref": "g0" }
{ "type": "gen.delta",      "field": "title",       "text": "ProReach Heavy-Duty " }
{ "type": "gen.field_done", "field": "title" }
{ "type": "gen.delta",      "field": "description", "text": "Meet the ProReach …" }
{ "type": "gen.field_done", "field": "description" }
{ "type": "gen.text_done",  "listing": { /* finalized listing text */ } }
```

fake-gen can simulate this trivially and contract-accurately. Because the final
text is already computed deterministically (§3), we **slice the finished strings
into chunks and emit them on a timer**:

```ts
async function* fakeTextStream(query: string, vertical: string, variant: number) {
  const l = fakeListing(query, vertical, variant);
  yield { type: "gen.start", fields: ["title", "description", "specs"], client_ref: `g${variant}` };
  for (const field of ["title", "description"] as const) {
    for (const chunk of chunkWords(l[field], 3)) {       // 3 words at a time
      await sleep(FAKE_STREAM_DELTA_MS);                 // configurable cadence
      yield { type: "gen.delta", field, text: chunk };
    }
    yield { type: "gen.field_done", field };
  }
  yield { type: "gen.text_done", listing: l };
}
```

**Transport / boundary:** fake-gen does **not** talk to the client. Per charter
§4.3 the stream must ride **api's** SSE fan-out keyed on `generation_id`. Two
options, pick in `01-backend-api.md`:

- **Simplest (recommended for Stage 1):** keep streaming **off** (`FAKE_STREAM=0`).
  The fast path returns finished text in `POST /generate` with
  `media.status = "generating_media"`; the client renders text instantly (which is
  the architecture's reuse-hit behavior). This fully satisfies the charter's
  functional states without a streaming transport, and §6 below still exercises the
  async image swap.
- **Stream-enabled (`FAKE_STREAM=1`, to exercise `generating_text`):** `POST
  /generate` returns quickly with `status: "generating_text"` and **no** listing
  text yet (just `client_ref`s and `generation_id`); fake-gen then streams the
  events above to api via an internal SSE/HTTP channel
  (`GET /generate/stream/:generationId`), and api relays them onto its client SSE
  channel `gen:{generation_id}`. Keep concurrent live streams to 1–2 (architecture
  02 §4.7 rule 8); the rest of the batch lands finalized.

Either way the **event shapes are the real ones** — Stage 2's streaming Claude
call emits the identical `gen.*` events; only the producer changes.

### 6.2 `images.ready` / `images.degraded` — the async swap event

This is **not optional** — it's the headline Stage 1 demo beat (skeleton →
placeholder → ready). The event shape is architecture 02 §8.2 verbatim, and per
charter §4.3 it rides api's realtime SSE fan-out **keyed on `generation_id`**:

```jsonc
// images.ready — emitted by API's realtime gateway after it ingests final media
{ "type": "images.ready",
  "generation_id": "gen_01H...", "listing_id": "lst_01H...",   // api filled listing_id in
  "media": { "status": "ready",
             "hero": { "url": "http://localhost:9000/dopamine/.../hero.svg",  // MinIO URL
                       "kind": "final", "blurhash": "...", "aspect_ratio": "1:1" },
             "alternates": [{ "url": "...", "blurhash": "...", "aspect_ratio": "1:1" }] } }

// images.degraded
{ "type": "images.degraded",
  "generation_id": "gen_01H...", "listing_id": "lst_01H...",
  "media": { "status": "degraded",
             "hero": { "url": "http://localhost:9000/dopamine/.../placeholder.svg",
                       "kind": "placeholder", "blurhash": "...", "aspect_ratio": "1:1" } } }
```

**Flow (recommended poll variant, §2.2):**

1. fake-gen `POST /generate` → api persists, returns placeholder grid, and enqueues
   a BullMQ delayed job (`delay = expected_ready_ms`).
2. Job fires in the `worker` → `GET fake-gen:8090/media/:generationId`.
3. fake-gen returns `outcome: ready|degraded` + per-`client_ref` final media
   (`source.url` to fetch).
4. worker maps `client_ref → listing_id`, fetches each `source.url`, PUTs to MinIO,
   updates the listing (`media`, `status`), and asks the realtime gateway to
   publish `images.ready`/`images.degraded` on the channel keyed on
   `generation_id`.
5. Client (subscribed on `generation_id` from the sync response) re-reads `media`
   and cross-fades. It **never re-fetches the listing** (architecture 02 §1.4
   rule 3); the thin payload carries everything.

Per charter §4.3, every event over the SSE fan-out carries a monotonic `seq` and
server `ts`; the realtime gateway (owned by `01-backend-api.md`) stamps those —
fake-gen does not. fake-gen's only job here is to *signal readiness and hand over
final bytes/URLs*.

---

## 7. Configurable fake latency / failure knobs

All env vars on the `fake-gen` container (declared in
[`04-docker-infra.md`](./04-docker-infra.md)). They let a reviewer feel the
skeleton → placeholder → ready timing and force the `degraded` path on demand.

| Env var | Default | Effect |
|---|---|---|
| `FAKE_GEN_PORT` | `8090` | Listen port. |
| `FAKE_TEXT_DELAY_MS` | `0` | Artificial delay before `POST /generate` responds (simulate fast-path text latency; architecture 02 targets p50 < 2.5 s). |
| `FAKE_MEDIA_DELAY_MS` | `1500` | Delay before final media is available (drives `expected_ready_ms` and the swap timing). Set higher to make the placeholder→final transition obvious in a demo. |
| `FAKE_MEDIA_MODE` | `twophase` | `twophase` (placeholder then async `ready`) or `inline` (return `status: ready` with final media immediately — skips the async event). |
| `FAKE_FAILURE_RATE` | `0` | Probability (0..1) that an enrichment resolves `degraded` instead of `ready`. **Deterministic per generation** (seeded by `generation_id`) so a given query reproducibly degrades — repeatable demos. Set `1` to force the degraded path. |
| `FAKE_STREAM` | `0` | `1` enables the COLD field-by-field token stream (§6.1); fast path then starts in `generating_text`. |
| `FAKE_STREAM_DELTA_MS` | `60` | Per-chunk cadence for the token stream. |
| `FAKE_FAIL_GENERATE` | `0` | `1` makes `POST /generate` return the `generation_failed` error envelope (§2.3) — to exercise api's failure handling. |
| `FAKE_DEFAULT_COUNT` | `1` | `count` used if api omits it. |
| `FAKE_GRID_MAX` | `24` | Upper bound fake-gen will honor for `count` (matches §4.7 `gridTarget`). |

`FAKE_FAILURE_RATE`'s determinism is important: failure is decided by
`rng(seed(generation_id))() < FAKE_FAILURE_RATE`, *not* `Math.random()`, so the
same query degrades (or not) every run — demos and tests stay reproducible.

---

## 8. Container

Owned in detail by [`04-docker-infra.md`](./04-docker-infra.md); summary here for
completeness.

```yaml
# docker-compose (excerpt — 04 owns the full file)
fake-gen:
  build: ./apps/fake-gen
  ports: ["8090:8090"]
  environment:
    FAKE_GEN_PORT: 8090
    FAKE_MEDIA_DELAY_MS: 1500
    FAKE_FAILURE_RATE: 0
    FAKE_MEDIA_MODE: twophase
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:8090/healthz"]
    interval: 5s
    timeout: 2s
    retries: 5
```

- **No dependencies on Postgres, Redis, or MinIO.** fake-gen is a pure content
  function — it touches none of them (that's the whole boundary point). It does
  not even need credentials. This is what makes the Stage-2 swap a swap.
- **Same network as `api`** so api reaches it at `http://fake-gen:8090` and (poll
  variant) the `worker` reaches `GET /media`.

---

## 9. What changes in Stage 2 (proving the seam)

The entire value of `fake-gen` is that this list is **short and localized to one
container**. Charter §2: "Stage 02 can replace that one container with the real
pipeline without touching `api`."

**What gets replaced (all *inside* the `fake-gen` → real-generation container):**

| Stage 1 (fake) | Stage 2 (real) |
|---|---|
| `fakeListing()` templated text from seeded hash | **Claude** (`claude-opus-4-8` / `claude-haiku-4-5`) structured-output call (architecture 02 §2). |
| SVG/solid-color placeholder bytes | **Flux Schnell** fast-path placeholder + **gpt-image-1.5** final hero/alternates (architecture 02 §3). |
| Title-collision de-dupe in the batch | **embedding de-dupe** before persist (architecture 02 §4.7); `text-embedding-3-large` + pgvector (architecture 02 §4.4). |
| `FAKE_MEDIA_DELAY_MS` timer → `GET /media` | real **image-provider webhook**, async worker (architecture 02 §3.4). |
| `FAKE_FAILURE_RATE` deterministic degrade | real retry/timeout exhaustion → `degraded` (architecture 02 §3.4). |
| No moderation, no budget | input/output moderation gates (§6) + per-user/global budgets (§5). |
| `gen.*` events sliced from finished strings | **streaming `messages.create`** field-by-field deltas (architecture 02 §1.4). |

**What stays identical (the seam — proof the design holds):**

- The **HTTP contract**: `POST /generate` request/response shape, the `media`
  states (`generating_text`/`generating_media`/`ready`/`degraded`), the `origin`
  union, the `images.ready`/`images.degraded` event shapes, the error envelope.
- The **boundary**: api still owns canonicalization, exact-cache, the generation
  lock, idempotency, **image ingestion to MinIO/R2**, the transactional catalog
  write, the blended grid policy, budgets, and the realtime fan-out. None of that
  code changes.
- The **container topology**: same port, same place in compose, same "produces
  content, returns bytes/URLs, signals readiness" role. Stage 2 changes
  fake-gen → real generation, MinIO → R2 (per charter §2 mapping) — both swaps,
  not redesigns.

If a Stage-2 change forces an edit to `api`, the seam leaked — and this doc is the
contract to point back at.

---

## 10. Exit checklist

`fake-gen` is **done** for Stage 1 when:

- [ ] `fake-gen` container builds and `docker compose up` brings it healthy on
      `:8090` with **no** Postgres/Redis/MinIO/credentials dependency.
- [ ] `POST /generate` returns the architecture 02 §8.1 shape (validated against the
      shared Zod schema from `05-contracts-and-sdk.md`): `generation_id`, `origin`
      (`"generated"`), `status`, and a `listings[]` array each with full text +
      `media` (`status: generating_media`, placeholder hero, blurhash,
      `expected_ready_ms`, `generation_id`, `image_prompts`).
- [ ] **Determinism:** the same `(query, vertical, count)` yields byte-identical
      text, prices, and image bytes across repeated calls and container restarts
      (a golden-file test asserts this).
- [ ] **Multi-listing:** `count = N` returns N **distinct** variants (different
      brand/material/price), capped at `FAKE_GRID_MAX`, that fill the grid.
- [ ] **Placeholder images:** `GET /img/ph/...` returns deterministic SVG bytes;
      `media.hero.source` instructs api to ingest (`{ ingest: "fetch", url }`) —
      fake-gen never writes MinIO.
- [ ] **Two-phase progression:** after `FAKE_MEDIA_DELAY_MS`,
      `GET /media/:generationId` returns final media; api ingests and the client
      receives `images.ready` (shape per architecture 02 §8.2) keyed on
      `generation_id`, swapping placeholder → final with no re-fetch.
- [ ] **Degraded path:** `FAKE_FAILURE_RATE=1` reproducibly yields
      `images.degraded` with the placeholder retained and the listing still
      orderable.
- [ ] **Latency knobs:** `FAKE_TEXT_DELAY_MS` / `FAKE_MEDIA_DELAY_MS` visibly move
      the skeleton→placeholder→ready timing in the running app.
- [ ] **Optional stream:** with `FAKE_STREAM=1`, fake-gen emits the
      `gen.start/delta/field_done/text_done` sequence and api relays it on
      `gen:{generation_id}`, driving the `generating_text` state. (Off by default.)
- [ ] **Boundary respected:** code review confirms fake-gen does **no**
      canonicalization, caching, locking, id-minting, persistence, MinIO writes, or
      SSE fan-out — those are all in `01-backend-api.md`'s gateway.
- [ ] **Seam proven:** a one-page note maps each fake internal (§9) to its Stage 2
      replacement, with the HTTP contract + the api boundary marked unchanged.
- [ ] Contributes to the charter §6 acceptance demo: searching a brand-new term
      produces an instant placeholder grid that materializes to final images, and a
      re-search hits api's cache (fake-gen not called the second time).
