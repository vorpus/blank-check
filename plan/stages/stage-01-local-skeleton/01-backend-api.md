# Stage 01 · 01 — Backend / Domain (NestJS modular monolith)

> **Workstream:** Backend / domain. **Owns:** the `api` service (NestJS modules),
> the Prisma schema + migrations + seed, the `/v1` OpenAPI surface, the
> search→miss→generate→persist seam, idempotency, the (simplified) blended grid
> policy, and the retail order state machine + its simulation (run by `worker`).
>
> **Realizes:** architecture **01** (domain/modules/API), **00 §4** (contracts),
> **02 §4.7** (blended grid — simplified), **04 §2/§5/§6** (simulation, event
> contract, snapshot+replay) — re-cut **local-first with a stubbed generation
> seam** and **no embeddings**.
>
> **Conforms to** the Stage 1 charter ([`README.md`](README.md)) §2–§4 (frozen).
> Where this doc says "the canonical type lives in" something, the authoritative
> TypeScript/Zod shape is owned by **[`05-contracts-and-sdk.md`](05-contracts-and-sdk.md)**
> and is *not redefined here*. Sibling boundaries:
> [`02-fake-generation.md`](02-fake-generation.md) (the `GenerationProvider` HTTP
> service we call), [`03-web-frontend.md`](03-web-frontend.md) (our API consumer),
> [`04-docker-infra.md`](04-docker-infra.md) (the shared api/worker image, the
> migrate/seed one-shot, container wiring).

---

## 1. Scope cut for Stage 1

| Architecture says | Stage 1 does | Deferred |
|---|---|---|
| Postgres FTS **+ pgvector** | **FTS + `pg_trgm` only** | pgvector / `embedding` column → **Stage 2** |
| Semantic dedup (cosine ≥ 0.92) | **Exact-cache (`canon_key`) + FTS match** | semantic dedup → Stage 2 |
| Blended grid using `s_max` | **FTS `matchCount` + Redis `popularity`** | `s_max` regime input → Stage 2 |
| Real `GenerationProvider` (Claude) | **HTTP call to `fake-gen`** behind the *same* interface | real pipeline → Stage 2 |
| Retail **and** food verticals | **retail only registered** (registry still exercised) | food → Stage 7 |
| JWT accounts | **anonymous/device bearer** only | accounts → Stage 4 |
| Ably fan-out | **SSE from `api` + Redis pub/sub** | Ably → Stage 5 |
| R2 + CDN | **MinIO** (S3 API) | R2 → Stage 5 |

Everything we *do* build honors the full contract so the deferred items are
drop-in swaps, never rewrites.

---

## 2. Module map (Stage 1)

NestJS modular monolith, Fastify adapter. Each module owns its tables, exposes an
in-process **provider interface**, and talks to peers only through those
interfaces + the **domain event bus** — never by reaching into another module's
tables (arch 01 §2.1).

```
┌───────────────────────────────────────────────────────────────────────┐
│  ApiGatewayModule  — REST controllers (/v1) + SSE controller           │
│  Zod ValidationPipe · IdempotencyInterceptor · DeviceAuthGuard         │
└───┬──────┬──────────┬───────┬─────────┬───────────┬─────────┬──────────┘
    ▼      ▼          ▼       ▼         ▼           ▼         ▼
┌────────┐┌────────┐┌────────┐┌──────┐┌────────┐┌──────────┐┌────────────┐
│Identity││Catalog ││Search  ││Cart  ││Orders  ││Fulfillment││Generation │
│Module  ││Module  ││Module  ││Module││Module  ││/Tracking  ││Gateway    │
└────────┘└───┬────┘└───┬────┘└──────┘└───┬────┘└────┬──────┘└─────┬──────┘
              │ persist │ miss            │ build/   │ ticks       │ enqueue
              │◄────────┘ generate        │ advance  │ + emit      │ + persist
              ▼          ▼                ▼ machine  ▼ events      ▼ write-back
        ┌───────────────────── PrismaModule (Postgres 16) ─────────────────┐
        │  RedisModule (cache · BullMQ · pub/sub · SETNX lock)             │
        │  StorageModule (MinIO/S3) · EventBusModule (in-proc + outbox)    │
        │  VerticalRegistryModule (retail only)                           │
        └─────────────────────────────────────────────────────────────────┘
```

| Module | Owns tables | In-process provider (the seam) | Talks to |
|---|---|---|---|
| **Identity** | `users` | `IdentityService.resolveDevice(deviceId)`, `issueToken(userId)` | — |
| **Catalog** | `storefronts`, `categories`, `listings` | `CatalogService.getListing`, `listCategories`, `writeBackGenerated(tx, …)` | Storage, Search (index), EventBus |
| **Search** | (indexes over Catalog) | `SearchService.search(q, ctx)` → grid + generation hint | Catalog, GenerationGateway, Redis |
| **Cart** | `carts`, `cart_items` | `CartService.getOrCreate`, `addItem`, `updateItem`, `removeItem` | Catalog |
| **Orders** | `orders`, `order_items` | `OrdersService.place(idemKey,…)`, `get`, `list`, `cancel`, `applyTransition` | Cart, Catalog, VerticalRegistry, Fulfillment, EventBus |
| **Fulfillment/Tracking** | `fulfillment_plans`, `tracking_events` | `FulfillmentService.buildPlan`, `advance`; `TrackingService.snapshot`, `stream` | Orders, VerticalRegistry, Redis pub/sub |
| **Generation Gateway** | `generation_jobs` | `GenerationGateway.requestGeneration(req)`, `onResult(res)` | Search, Catalog, fake-gen (HTTP), BullMQ |
| **Vertical Registry** | `verticals` (config) | `VerticalRegistry.get(verticalId)` → `{ stateMachine, fulfillment, tracking, catalogPolicy }` | (consumed by Catalog/Orders/Fulfillment) |

### 2.1 NestJS module/provider skeleton

```ts
// search.module.ts — representative of the pattern every module follows.
@Module({
  imports: [PrismaModule, RedisModule, CatalogModule, GenerationGatewayModule],
  providers: [SearchService, CanonicalizerService, GridPolicyService],
  controllers: [SearchController],
  exports: [SearchService],
})
export class SearchModule {}
```

```ts
// vertical-registry.module.ts — DI is what makes the registry first-class (arch 01 §6).
export const VERTICAL = Symbol('VERTICAL'); // multi-provider token

@Module({
  providers: [
    VerticalRegistry,
    RetailVertical,                                  // the only registered vertical in Stage 1
    { provide: VERTICAL, useExisting: RetailVertical, multi: true },
  ],
  exports: [VerticalRegistry],
})
export class VerticalRegistryModule {}

@Injectable()
export class VerticalRegistry {
  private readonly byId = new Map<string, Vertical>();
  constructor(@Inject(VERTICAL) verticals: Vertical[]) {
    for (const v of verticals) this.byId.set(v.id, v);   // { retail }
  }
  get(verticalId: string): Vertical {
    const v = this.byId.get(verticalId);
    if (!v) throw new UnknownVerticalError(verticalId);   // never an `if (vertical==='food')`
    return v;
  }
}
```

```ts
// The Vertical bundle (arch 01 §1.3). Stage 1 ships exactly one implementation.
export interface Vertical {
  id: string;                               // "retail"
  displayName: string;
  stateMachineKey: string;                  // "retail.v1"
  stateMachine: OrderMachineConfig;         // XState v5 config-as-data (§9)
  fulfillment: FulfillmentStrategy;         // buildPlan + nextTransition (§10)
  tracking: TrackingProvider;               // trackingMode: "timeline", no geo (§8)
  catalogPolicy: { generationEnabled: boolean; attributeSchema: object };
}
```

### 2.2 The in-process domain event bus

Synchronous publish to in-proc listeners for cheap reactions (e.g. Search cache
warm), **plus** a durable **transactional outbox** for cross-process / at-least-once
delivery (the worker, SSE fan-out). The outbox row is written **in the same DB
transaction** as the state change (arch 01 §8.1); a relay drains it to Redis
pub/sub + BullMQ.

```ts
export type DomainEvent =
  | { type: 'listing.generated'; listingId: string; storefrontId: string; canonicalQuery: string }
  | { type: 'order.placed';      orderId: string; verticalId: string }
  | { type: 'order.transition';  orderId: string; seq: number; state: string }
  | { type: 'images.ready';      generationId: string; listingId: string; media: MediaBlock }
  | { type: 'images.degraded';   generationId: string; listingId: string; media: MediaBlock };

@Injectable()
export class EventBus {
  constructor(private prisma: PrismaService, private emitter: EventEmitter2) {}

  /** Outbox write — MUST be called with the same `tx` as the state change. */
  async publishTx(tx: Prisma.TransactionClient, e: DomainEvent): Promise<void> {
    await tx.outboxEvent.create({
      data: { id: randomUUID(), type: e.type, payload: e as object, status: 'pending' },
    });
  }
  /** In-proc fast path (best-effort reactions only — never the source of truth). */
  emitLocal(e: DomainEvent) { this.emitter.emit(e.type, e); }
}

// OutboxRelay (runs in api AND worker): poll `outbox_event WHERE status='pending'`,
// publish to Redis pub/sub (channel `order:{id}` etc.) + enqueue BullMQ jobs,
// mark 'published'. Consumers dedupe via an inbox table keyed by event id.
```

> The canonical `DomainEvent` / `MediaBlock` / wire-event types live in
> **`05-contracts-and-sdk.md`**; the shapes above are the local view we depend on.

---

## 3. Prisma schema (Stage 1 tables)

Money is **integer cents** everywhere; currency is a column. `@@map` to snake_case.
**Where pgvector lands in Stage 2 is flagged inline — do not add it now.**

```prisma
// prisma/schema.prisma
generator client { provider = "prisma-client-js" }
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  // Stage 1 extensions. pgvector is intentionally absent until Stage 2.
  extensions = [pgTrgm(map: "pg_trgm")]   // + uuidOssp if used for defaults
}

// ── Identity ────────────────────────────────────────────────────────────────
model User {
  id        String   @id @default(uuid())
  deviceId  String   @unique                  // anonymous identity key (charter §4.4)
  kind      String   @default("anonymous")    // "anonymous" | "account" (Stage 4)
  createdAt DateTime @default(now())
  carts     Cart[]
  orders    Order[]
  @@map("users")
}

// ── Vertical registry (config rows; behavior is code in VerticalRegistry) ────
model Vertical {
  id              String      @id                 // "retail"
  displayName     String
  stateMachineKey String                          // "retail.v1"
  config          Json        @default("{}")
  generationOn    Boolean     @default(true)
  storefronts     Storefront[]
  @@map("verticals")
}

model Storefront {
  id         String     @id @default(uuid())
  verticalId String
  vertical   Vertical   @relation(fields: [verticalId], references: [id])
  name       String
  theme      Json       @default("{}")
  config     Json       @default("{}")
  categories Category[]
  listings   Listing[]
  @@map("storefronts")
}

model Category {
  id           String     @id @default(uuid())
  storefrontId String
  storefront   Storefront @relation(fields: [storefrontId], references: [id])
  parentId     String?
  parent       Category?  @relation("CatTree", fields: [parentId], references: [id])
  children     Category[] @relation("CatTree")
  name         String
  slug         String
  listings     Listing[]
  @@unique([storefrontId, slug])
  @@map("categories")
}

// ── Catalog ──────────────────────────────────────────────────────────────────
model Listing {
  id             String   @id @default(uuid())
  storefrontId   String
  storefront     Storefront @relation(fields: [storefrontId], references: [id])
  verticalId     String                            // carried on every listing (charter §4.1)
  categoryId     String?
  category       Category? @relation(fields: [categoryId], references: [id])
  title          String
  description    String
  priceCents     Int                               // integer cents — never floats
  currency       String    @default("USD")
  attributes     Json      @default("{}")          // per-vertical JSONB (size/color)
  media          Json      @default("{}")          // MediaBlock: { status, hero?, alts?, blurhash? }
  imageUrls      String[]  @default([])            // resolved MinIO URLs (mirror of media for fast reads)
  origin         String                            // "seed" | "generated" | "exact_cache" | "semantic_reuse"
  status         String    @default("ready")       // "skeleton" | "placeholder" | "ready" | "degraded"
  canonicalQuery String?                           // dedup key; null for hand-seeded browse items
  // searchDoc tsvector + the GIN/trgm indexes are added via raw SQL migration (§3.1).
  // ── STAGE 2 ADDS HERE: `embedding vector(1536)` + an HNSW index. NOT in Stage 1. ──
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  cartItems      CartItem[]
  @@unique([storefrontId, canonicalQuery])         // idempotent generation write-back (arch 01 §4.4)
  @@index([storefrontId, status])
  @@map("listings")
}

// ── Cart ──────────────────────────────────────────────────────────────────────
model Cart {
  id           String     @id @default(uuid())
  userId       String
  user         User       @relation(fields: [userId], references: [id])
  storefrontId String
  status       String     @default("active")       // one active cart per (user, storefront)
  version      Int        @default(0)              // optimistic concurrency (arch 01 §8.2)
  items        CartItem[]
  updatedAt    DateTime   @updatedAt
  @@unique([userId, storefrontId, status])         // partial-unique on status='active' via raw SQL
  @@map("carts")
}

model CartItem {
  id             String   @id @default(uuid())
  cartId         String
  cart           Cart     @relation(fields: [cartId], references: [id], onDelete: Cascade)
  listingId      String
  listing        Listing  @relation(fields: [listingId], references: [id])
  qty            Int
  unitPriceCents Int                                // snapshot at add-time
  @@unique([cartId, listingId])
  @@map("cart_items")
}

// ── Orders ─────────────────────────────────────────────────────────────────────
model Order {
  id              String      @id @default(uuid())
  userId          String
  user            User        @relation(fields: [userId], references: [id])
  verticalId      String                            // drives state-machine selection
  storefrontId    String
  state           String                            // current machine state
  stateMachineKey String                            // pinned version, e.g. "retail.v1" (arch 01 §1.4)
  totalCents      Int
  currency        String      @default("USD")
  idempotencyKey  String                            // place-order idempotency (charter §4.x)
  metadata        Json        @default("{}")
  seq             Int         @default(0)           // per-order monotonic tracking seq (charter §4.3)
  placedAt        DateTime    @default(now())
  items           OrderItem[]
  plan            FulfillmentPlan?
  events          TrackingEvent[]
  @@unique([userId, idempotencyKey])                // retried place-order returns the original
  @@index([userId, placedAt])
  @@map("orders")
}

model OrderItem {
  id                 String  @id @default(uuid())
  orderId            String
  order              Order   @relation(fields: [orderId], references: [id])
  listingId          String
  titleSnapshot      String                          // frozen at order time (arch 01 §1.2)
  unitPriceSnapshot  Int
  qty                Int
  @@map("order_items")
}

// ── Fulfillment / tracking ─────────────────────────────────────────────────────
model FulfillmentPlan {
  id          String   @id @default(uuid())
  orderId     String   @unique
  order       Order    @relation(fields: [orderId], references: [id])
  verticalId  String
  steps       Json                                  // ordered [{ state, delayMs, terminal? }]
  currentStep Int      @default(0)
  nextTickAt  DateTime?
  @@index([nextTickAt])                             // ticker scan `WHERE nextTickAt <= now()`
  @@map("fulfillment_plans")
}

model TrackingEvent {
  orderId    String
  order      Order    @relation(fields: [orderId], references: [id])
  seq        Int                                    // per-order, gap-free, monotonic (charter §4.3)
  type       String   @default("state_change")
  state      String
  label      String
  payload    Json     @default("{}")
  occurredAt DateTime @default(now())
  @@id([orderId, seq])                              // append-only replay log
  @@map("tracking_events")
}

// ── Generation jobs ─────────────────────────────────────────────────────────────
model GenerationJob {
  id             String   @id @default(uuid())
  storefrontId   String
  verticalId     String
  canonicalQuery String
  requestId      String   @unique                   // mirrors GenerationRequest.requestId
  status         String   @default("pending")       // pending|running|succeeded|degraded|failed
  regime         String                             // "warm" | "cold" (which grid regime spawned it)
  batchSize      Int      @default(1)
  generationId   String?                            // correlates async images.ready (charter §4.2)
  error          String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@unique([storefrontId, canonicalQuery])          // collapse concurrent identical misses
  @@map("generation_jobs")
}

// ── Outbox (transactional event publication) ───────────────────────────────────
model OutboxEvent {
  id          String   @id
  type        String
  payload     Json
  status      String   @default("pending")          // pending | published
  createdAt   DateTime @default(now())
  publishedAt DateTime?
  @@index([status, createdAt])
  @@map("outbox_events")
}
```

### 3.1 Raw-SQL migration for FTS + trigram (no pgvector)

Prisma can't express `tsvector`/GIN, so a hand-written migration adds them. The
generated column keeps `search_doc` always in sync — no app-side maintenance.

```sql
-- prisma/migrations/0002_search/migration.sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE listings
  ADD COLUMN search_doc tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(description,'')), 'B')
  ) STORED;

CREATE INDEX listings_search_doc_gin ON listings USING GIN (search_doc);   -- FTS
CREATE INDEX listings_title_trgm     ON listings USING GIN (title gin_trgm_ops); -- fuzzy/partial
CREATE INDEX listings_canon_idx      ON listings (storefront_id, canonical_query); -- exact lookup

-- one-active-cart-per-(user,storefront) as a partial unique index
CREATE UNIQUE INDEX carts_one_active ON carts (user_id, storefront_id) WHERE status = 'active';

-- STAGE 2 WILL ADD (do not run now):
--   CREATE EXTENSION vector;
--   ALTER TABLE listings ADD COLUMN embedding vector(1536);
--   CREATE INDEX listings_embedding_hnsw ON listings USING hnsw (embedding vector_cosine_ops);
```

---

## 4. The search → miss → generate → persist seam

This is the signature flow (arch 01 §4, charter §4.2). Stage 1 wires **every**
seam — canonicalization, exact-cache, SETNX lock, enqueue, idempotent
transactional write-back, outbox — but the *content* comes from `fake-gen`.

```mermaid
sequenceDiagram
  participant C as web
  participant S as SearchModule
  participant R as Redis
  participant G as GenerationGateway
  participant FG as fake-gen (HTTP)
  participant W as worker
  participant DB as Postgres

  C->>S: GET /v1/search?q=a ladder
  S->>S: canonicalize → "ladder"
  S->>R: GET cache canon:{sf}:ladder
  alt exact-cache HIT
    R-->>S: listing_id(s)
    S->>DB: load listings → return grid (origin=exact_cache)
  else MISS — run blended grid policy (§5)
    S->>DB: FTS + trgm → matchCount, filler listings
    S->>R: INCR pop:{sf}:ladder (popularity)
    S->>R: SET NX gen:lock:{sf}:ladder PX 30000
    alt lock acquired
      S->>G: requestGeneration({canonicalQuery, batchSize})
      G->>DB: upsert generation_jobs (unique sf+canon) status=pending
      G->>FG: POST /generate (GenerationRequest, requestId)   %% fast path
      FG-->>G: GenerationResult { listing{…media: generating_media}, generation_id, origin }
      G->>DB: TXN writeBackGenerated() + outbox(listing.generated)  (§4.4)
      G->>R: SET canon:{sf}:ladder = listing_id
    else lock lost
      Note over S: attach to in-flight job; return skeleton cards
    end
    S-->>C: { items:[filler…, skeleton×k], generation:{ status, generationId, pollAfterMs } }
  end
  Note over W,FG: async — fake-gen later emits images.ready (generation_id) →
  W->>DB: TXN update listing.media=ready + outbox(images.ready)
  W-->>C: SSE images.ready (fan-out) → client swaps media
```

### 4.1 Canonicalization (the dedup/lock key)

```ts
@Injectable()
export class CanonicalizerService {
  canon(raw: string): string {
    return raw.toLowerCase().trim()
      .replace(/[^\p{L}\p{N}\s]/gu, '')        // strip punctuation
      .replace(/\b(a|an|the|some|please)\b/g, '') // strip filler
      .replace(/\s+/g, ' ').trim()
      .replace(/s\b/g, '');                     // naive singularize (Stage 1 — good enough)
  }
  cacheKey(sf: string, c: string) { return `canon:${sf}:${c}`; }
  lockKey(sf: string, c: string)  { return `gen:lock:${sf}:${c}`; }
  popKey(sf: string, c: string)   { return `pop:${sf}:${c}`; }
}
```

> **No semantic dedup in Stage 1.** Arch 01 §4.3's pgvector ANN reuse is a Stage 2
> insert *before* the lock step. The exact-cache + the `(storefront_id,
> canonical_query)` unique constraint are the only dedup we run now.

### 4.2 Exact-cache + generation lock (Redis)

- **L1 exact-cache:** `canon:{storefront}:{canonical} → listing_id`. A hit returns
  instantly with `origin: "exact_cache"`, no DB write, no generation.
- **Generation lock:** `SET gen:lock:{sf}:{canon} NX PX 30000`. Only the first
  concurrent miss enqueues; losers return the skeleton and attach to the same
  `generation_jobs` row (collapses the thundering herd — arch 02 §4.5).

### 4.3 Enqueue

`GenerationGateway.requestGeneration` upserts the `generation_jobs` row (unique
`(storefront_id, canonical_query)` makes the upsert the dedup point), then in
Stage 1 calls `fake-gen`'s **fast path synchronously** to get the placeholder
listing back immediately (so search can return real skeleton cards with a
`listing_id`), and enqueues a BullMQ `generation.enrich` job for the async
image-ready progression that the **worker** owns.

### 4.4 Transactional, idempotent catalog write-back

The write is **one Postgres transaction**; images are ingested to MinIO *before*
the row commits so no row references a missing blob (arch 01 §4.4). The unique
constraint makes a retried job a no-op via upsert.

```ts
// catalog.service.ts — owned by Catalog, called by GenerationGateway.
async writeBackGenerated(input: GeneratedListingInput): Promise<Listing> {
  const urls = await this.storage.ingest(input.images);   // MinIO PUT before commit
  return this.prisma.$transaction(async (tx) => {
    const listing = await tx.listing.upsert({
      where:  { storefrontId_canonicalQuery: {            // idempotency key (§4.4)
        storefrontId: input.storefrontId, canonicalQuery: input.canonicalQuery } },
      create: {
        ...input.fields, storefrontId: input.storefrontId, verticalId: input.verticalId,
        canonicalQuery: input.canonicalQuery, origin: 'generated',
        status: input.media.status === 'ready' ? 'ready' : 'placeholder',
        media: input.media, imageUrls: urls, priceCents: input.fields.priceCents,
      },
      update: { media: input.media, imageUrls: urls, status: 'placeholder' }, // retry-safe
    });
    await this.eventBus.publishTx(tx, {                    // outbox, same txn
      type: 'listing.generated', listingId: listing.id,
      storefrontId: input.storefrontId, canonicalQuery: input.canonicalQuery,
    });
    return listing;
  });
}
```

After commit, the `OutboxRelay` publishes `listing.generated`; the exact-cache is
set (`SET canon:{sf}:{canon} = listing.id`) so the *next* identical search is an
instant L1 hit — exactly the demo's "re-search → cache hit" step.

---

## 5. Blended grid policy (simplified — no embeddings)

Per arch 02 §4.7 a search returns a **populated grid** (target **24** cards),
blending cache vs. generate across three regimes. Stage 1 has no embeddings, so
**we drop the `s_max` input** and decide on **FTS `matchCount` + a Redis
`popularity` counter** only.

| Signal | Arch (Stage 2) source | **Stage 1 source** |
|---|---|---|
| `matchCount` | listings above relevance floor | **count of FTS/trgm hits** |
| `popularity` | decaying Redis counter on `canon_key` | **same** (Redis `INCR`, TTL decay) |
| ~~`s_max`~~ | top pgvector cosine | **omitted** (no vectors yet) |

```ts
const GRID_TARGET = 24;

@Injectable()
export class GridPolicyService {
  classify(matchCount: number, popularity: number): GridPlan {
    if (matchCount >= GRID_TARGET || popularity >= HOT_POP)               // 🔥 hot
      return { regime: 'hot',  fromCache: GRID_TARGET, generate: 0 };
    if (matchCount >= 1)                                                  // 🌤 warm
      return { regime: 'warm', fromCache: matchCount,  generate: GRID_TARGET - matchCount };
    return { regime: 'cold', fromCache: COLD_FILLER, generate: COLD_BATCH }; // ❄️ cold (e.g. 8)
  }
}
```

- **🔥 Hot:** `matchCount ≥ 24` (or popularity hot) → full grid from cache, **0 generated**.
- **🌤 Warm:** `1 ≤ matchCount < 24` → return the matches now, generate `24 − matchCount`
  distinct cards as one batch (`fake-gen` returns a *set* of distinct variants).
- **❄️ Cold:** `matchCount == 0` → a few loosely-related trgm filler cards as instant
  filler (relax the FTS bar — accept partial/fuzzy trgm matches), **generate a batch
  of `K` (8)** with the first card returned as a live skeleton.

The COLD/WARM generation requests are routed through §4's lock+enqueue. Stage 1
keeps the §2-deferred budget circuit-breaker as a simple global concurrent-job cap
(no per-user metering until Stage 4). The `regime` is persisted on
`generation_jobs.regime` for later tuning.

---

## 6. Identity (anonymous-first)

Charter §4.4: a `deviceId` resolves/creates a lightweight `user`; a short-lived
bearer token scopes requests. **Same bearer scheme** Stage 4 issues real accounts
under — so account upgrade is a token-issuer swap, not a re-plumb.

```ts
@Injectable()
export class IdentityService {
  async resolveDevice(deviceId: string): Promise<User> {
    return this.prisma.user.upsert({
      where: { deviceId }, update: {},
      create: { deviceId, kind: 'anonymous' },
    });
  }
  issueToken(userId: string): string {                  // Stage 1: signed opaque/JWT, short TTL
    return this.jwt.sign({ sub: userId, kind: 'anonymous' }, { expiresIn: '12h' });
  }
}
```

- `POST /v1/identity/device` — body `{ deviceId }` (or bootstrap from an
  `X-Device-Id` header) → `{ userId, token }`.
- `DeviceAuthGuard` validates `Authorization: Bearer <token>` on protected routes
  and attaches `req.user`. The bearer payload shape and the validation are owned
  by **`05-contracts-and-sdk.md`** so Stage 4 reuses them verbatim.

---

## 7. REST `/v1` surface + OpenAPI 3.1

All routes URL-versioned under `/v1`; Zod validates every boundary; OpenAPI 3.1
is generated from Nest decorators (`@nestjs/swagger`) and is the **source of truth
for the SDK** (`05-contracts-and-sdk.md` generates the typed client from it).

| Operation | Method + path | Notes |
|---|---|---|
| Bootstrap device | `POST /v1/identity/device` | `{deviceId}` → `{userId, token}` (charter §4.4) |
| Search | `GET /v1/search?q=&storefrontId=` | Returns blended grid + `generation` hint; never blocks (§5) |
| Listing detail | `GET /v1/listings/{id}` | `attributes`, `media`, `imageUrls`, `status` |
| List categories | `GET /v1/storefronts/{id}/categories` | Catalog browse tree |
| Get/create cart | `GET /v1/cart?storefrontId=` | Active cart for (user, storefront) |
| Add item | `POST /v1/cart/items` | `{listingId, qty}` → recalculated totals + `version` |
| Update item | `PATCH /v1/cart/items/{id}` | qty change; optimistic `version` check |
| Remove item | `DELETE /v1/cart/items/{id}` | recalculated totals |
| **Place order** | `POST /v1/orders` + `Idempotency-Key` header | snapshots cart → order; builds plan (§10) |
| Order detail | `GET /v1/orders/{id}` | **vertical-agnostic** `display.stages`/`trackingMode`/`capabilities` (§7.1); polling fallback |
| List orders | `GET /v1/orders` | history |
| Cancel order | `POST /v1/orders/{id}/cancel` | only if the active machine allows from current state → else 409 |
| **Tracking snapshot** | `GET /v1/orders/{id}/tracking` | authoritative `{state, seq, stages}` for replay catch-up (charter §4.3) |
| **Tracking stream** | `GET /v1/orders/{id}/stream` (SSE) | `tracking_event` frames + `images.ready`/`degraded`; `Last-Event-ID` replay |

### 7.1 The vertical-agnostic order payload (charter §4.1 — frozen)

`GET /v1/orders/{id}` carries **presentation as data**. Stages come from the
vertical's state machine, marked `reached`/`current` against the live `state`.
The client never hardcodes a retail enum.

```jsonc
{
  "id": "ord_123",
  "verticalId": "retail",
  "state": "shipped",
  "display": {
    "trackingMode": "timeline",                 // "map" reserved for food (charter §4.1)
    "stages": [
      { "key": "confirmed",        "label": "Confirmed",        "reached": true  },
      { "key": "packed",           "label": "Packed",           "reached": true  },
      { "key": "shipped",          "label": "Shipped",          "reached": true, "current": true },
      { "key": "out_for_delivery", "label": "Out for delivery", "reached": false },
      { "key": "delivered",        "label": "Delivered",        "reached": false }
    ]
  },
  "capabilities": { "liveLocation": false },     // retail → false (charter §4.1)
  "streamUrl": "/v1/orders/ord_123/stream",
  "items": [ /* OrderItem snapshots */ ],
  "totalCents": 18900, "currency": "USD"
}
```

> The authoritative TypeScript/Zod type for this payload (and `display.stages`,
> `trackingMode`, `capabilities`) is owned by **`05-contracts-and-sdk.md`**.

### 7.2 SSE framing (charter §4.3)

Each event carries the per-order monotonic `seq` and server `ts`. Transport uses
`Last-Event-ID` to replay from the `tracking_events` log on reconnect; polling
`GET /v1/orders/{id}` is the always-available fallback.

```
id: 3
event: tracking_event
data: {"orderId":"ord_123","seq":3,"state":"shipped","label":"Shipped","ts":1750464001000}

event: images.ready
data: {"generationId":"gen_88","listingId":"lst_42","media":{"status":"ready","hero":"…"}}
```

### 7.3 OpenAPI generation

```ts
// main.ts (api entrypoint)
const config = new DocumentBuilder()
  .setTitle('Dopamine API').setVersion('1.0.0')
  .addBearerAuth()                                  // the anonymous device bearer
  .build();
const doc = SwaggerModule.createDocument(app, config);
writeFileSync('openapi.json', JSON.stringify(patchTo31(doc)));  // emit 3.1 for the SDK
SwaggerModule.setup('/v1/docs', app, doc);
```

Controllers use `@ApiOkResponse({ type: … })` DTOs derived from the shared Zod
schemas (`nestjs-zod` → `createZodDto`) so the spec, the runtime validation, and
the SDK types are one source of truth (`05-contracts-and-sdk.md`).

---

## 8. Tracking provider (retail, Stage 1)

`trackingMode: "timeline"`, `emitsGeo: false`, `capabilities.liveLocation: false`.
`TrackingService` serves the **snapshot** (`GET /v1/orders/{id}/tracking`, read
straight from `orders` + latest `tracking_events`) and the **SSE stream** (Redis
pub/sub subscription on `order:{id}` + `Last-Event-ID` replay from the
`tracking_events` log). This is the local stand-in for arch 04's Ably layer; the
event contract (§7.2) is identical so Stage 5 swaps the transport, not the client.

---

## 9. Retail order state machine (XState v5, config-as-data)

The order graph is **data**, keyed `retail.v1` and **pinned** on each order
(`stateMachineKey`) so editing the machine never corrupts in-flight orders
(arch 01 §1.4). The Orders module is generic: it asks the machine whether a
transition is legal, applies it, and emits a `TrackingEvent` — **no
`if (vertical === …)` branches**.

> **Contract reconciliation:** arch 01 §1.4 names retail states
> `placed→packing→shipped→out_for_delivery→delivered`; arch 04 §1.3 names them
> `confirmed→packed→shipped→out_for_delivery→delivered`. These are the same
> 5-stage timeline under different labels. **Stage 1 freezes the doc-04 spelling**
> (`confirmed, packed, shipped, out_for_delivery, delivered`) because it is the
> one the simulation engine and `display.stages` already use; `cancelled` is the
> non-terminal-state escape. This is the only contract ambiguity I had to resolve.

```ts
// verticals/retail/state-machine.ts — XState v5 config-as-data (storable/versionable).
export const retailMachine: OrderMachineConfig = {
  id: 'retail.v1',
  initial: 'confirmed',
  states: {
    confirmed:        { on: { dispatch_packing: 'packed',   cancel: 'cancelled' } },
    packed:           { on: { ship:             'shipped',   cancel: 'cancelled' } },
    shipped:          { on: { arrive_local:     'out_for_delivery' } },
    out_for_delivery: { on: { deliver:          'delivered' } },
    delivered:        { type: 'final' },
    cancelled:        { type: 'final' },
  },
};
```

### 9.1 Generic transition validation + event emission

```ts
@Injectable()
export class OrdersService {
  /** Applies an event against the order's PINNED machine. One transaction:
   *  validate → update state → bump seq → append TrackingEvent → outbox. */
  async applyTransition(orderId: string, event: string) {
    return this.prisma.$transaction(async (tx) => {
      const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      const machine = this.registry.get(o.verticalId).stateMachine;  // pinned by stateMachineKey
      const next = resolveTransition(machine, o.state, event);
      if (!next) throw new IllegalTransitionError(o.state, event);    // → HTTP 409 (arch 01 §1.4)

      const seq = o.seq + 1;
      await tx.order.update({ where: { id: orderId }, data: { state: next, seq } });
      await tx.trackingEvent.create({ data: {                        // append-only, every transition
        orderId, seq, state: next, label: labelFor(next),
      }});
      await this.eventBus.publishTx(tx, { type: 'order.transition', orderId, seq, state: next });
      return next;
    });
  }
}
```

`cancel` routes through the **same** `applyTransition` — the machine rejects it
from `shipped`/`out_for_delivery` (no `cancel` edge there) yielding 409, so cancel
is not special-cased. Terminal states (`delivered`, `cancelled`) stop the ticker.

---

## 10. Fulfillment simulation (run by the `worker`)

At checkout, the retail `FulfillmentStrategy.buildPlan` produces the ordered steps
with **accelerated** delays (a global `TIME_SCALE` compresses "days" → seconds for
the demo — config, not code, per arch 04 §1.3).

```ts
const hours = (h: number) => Math.round(h * 3600_000 / TIME_SCALE);   // TIME_SCALE e.g. 3600 ⇒ "1h"→1s

class RetailFulfillment implements FulfillmentStrategy {
  buildPlan(order: Order): PlanSteps {
    return [
      { state: 'packed',           event: 'dispatch_packing', delayMs: hours(2)  },
      { state: 'shipped',          event: 'ship',             delayMs: hours(6)  },
      { state: 'out_for_delivery', event: 'arrive_local',     delayMs: hours(28) },
      { state: 'delivered',        event: 'deliver',          delayMs: hours(3), terminal: true },
    ];
  }
}
```

### 10.1 The advance loop (durable, idempotent, restart-safe)

Per arch 04 §2: the `advance` job is the engine. On place-order we persist the
order (`state='confirmed'`, `seq=0`) and enqueue `advance` with the first step's
delay. Each `advance` does, **in one transaction**, the §9.1 transition + enqueues
the *next* `advance` (via the outbox so we never "advance but lose the next step").

```ts
// worker/processors/advance.processor.ts (BullMQ)
async function advance(job: { orderId: string; fromState: string; fromSeq: number }) {
  const result = await prisma.$transaction(async (tx) => {
    const o = await tx.order.findUniqueOrThrow({ where: { id: job.orderId } });
    if (o.state !== job.fromState || o.seq !== job.fromSeq) return null;  // idempotent no-op (redelivery)
    const plan = await tx.fulfillmentPlan.findUniqueOrThrow({ where: { orderId: o.id } });
    const step = (plan.steps as PlanSteps)[plan.currentStep];
    if (!step) return null;

    const next = await orders.applyTransitionTx(tx, o, step.event);      // §9.1 within this tx
    await tx.fulfillmentPlan.update({ where: { orderId: o.id },
      data: { currentStep: plan.currentStep + 1,
              nextTickAt: step.terminal ? null : new Date(Date.now() + nextDelay(plan)) } });
    return { next, seq: o.seq + 1, terminal: step.terminal };
  });
  if (result && !result.terminal)                                        // schedule the next tick
    await queue.add('advance', { orderId: job.orderId, fromState: result.next, fromSeq: result.seq },
                    { delay: nextStepDelay });
}
```

The `OutboxRelay` (running in the worker too) publishes each `order.transition` to
Redis pub/sub `order:{id}`; the `api`'s SSE controller, subscribed to that
channel, frames it (§7.2) and the client renders from `display.stages`.

---

## 11. The shared api/worker image

`api` and `worker` are **one codebase, one Docker image, two entrypoints**
(charter §2; container build owned by **`04-docker-infra.md`**):

| Entrypoint | Bootstraps | Runs |
|---|---|---|
| `api` (`main.ts`) | full Nest HTTP app (Fastify) | REST `/v1`, SSE, OpenAPI, OutboxRelay |
| `worker` (`worker.ts`) | Nest **application context** (no HTTP) | BullMQ processors: `advance` (fulfillment), `generation.enrich` (image-ready progression), OutboxRelay |

```ts
// worker.ts — same modules, no HTTP server.
const ctx = await NestFactory.createApplicationContext(WorkerModule);
ctx.get(FulfillmentWorker).run();      // registers BullMQ processors
ctx.get(GenerationWorker).run();
ctx.get(OutboxRelay).run();
```

Because both import the same providers (Prisma, EventBus, VerticalRegistry), the
state-machine + transactional logic exists once and is reused identically by the
synchronous API path and the async worker path.

---

## 12. Idempotency & event-bus summary

| Surface | Mechanism |
|---|---|
| Place order | `Idempotency-Key` header → unique `(userId, idempotencyKey)` on `orders`; retry returns the original order (arch 01 §8.1) |
| Generation write-back | unique `(storefront_id, canonical_query)` → `upsert` makes retries no-ops (arch 01 §4.4) |
| Concurrent misses | Redis `SET NX` lock on `canon_key` (arch 02 §4.5) |
| Fulfillment ticks | `advance` carries `fromState`/`fromSeq`; mismatched → no-op (arch 04 §2.4) |
| Domain events | transactional **outbox** (same txn as state change) → relay → at-least-once; consumers dedupe via inbox keyed on event id |
| SSE ordering | per-order monotonic `seq`; client drops `seq <= lastApplied`, catches up via snapshot + replay (charter §4.3) |

---

## 13. Seed data

The `migrate`/`seed` one-shot (owned by `04-docker-infra.md`, this doc owns the
seed *content*) registers the `retail` vertical row, one storefront ("Mega-Mart"),
a small category tree, and a starter catalog of ~30 hand-authored `origin='seed'`
listings (`status='ready'`, `canonicalQuery` set) so browse works on a cold boot
and so a few searches are immediate **hot** hits. The acceptance "search a
brand-new term" path then exercises the full cold-miss → generate flow.

---

## 14. Exit checklist (verifiable backend deliverables)

- [ ] `prisma migrate deploy` creates all Stage 1 tables + the FTS/`pg_trgm`
      indexes; **no `vector` extension or `embedding` column exists** (Stage 2 marker present in SQL as a comment).
- [ ] `POST /v1/identity/device` issues a bearer token; protected `/v1` routes
      reject missing/invalid bearers; the token shape matches `05-contracts-and-sdk.md`.
- [ ] `GET /v1/search?q=` returns a **populated grid** (up to 24 cards) with the
      blended regime applied: a seeded term → **hot** (0 generated); a brand-new
      term → **cold** (filler + skeleton + a `generation` hint).
- [ ] A cold search enqueues exactly **one** `generation_jobs` row under
      concurrent identical requests (lock works); the write-back is transactional
      and idempotent (re-running the job creates no duplicate listing).
- [ ] Re-searching the same new term returns an **instant exact-cache hit**
      (`origin: "exact_cache"`, no new generation).
- [ ] Cart: get-or-create, add/update/remove recompute totals; one active cart per
      (device, storefront); optimistic `version` guards concurrent edits.
- [ ] `POST /v1/orders` with `Idempotency-Key` is idempotent (retry → same order);
      builds a `FulfillmentPlan`; snapshots `OrderItem` title/price.
- [ ] `GET /v1/orders/{id}` returns the **vertical-agnostic** payload
      (`display.stages`, `trackingMode:"timeline"`, `capabilities.liveLocation:false`)
      with stages derived from `retail.v1`, not hardcoded.
- [ ] The `worker` advances an order `confirmed → … → delivered` on accelerated
      timers; every transition appends a `TrackingEvent` with a monotonic `seq`;
      illegal transitions / cancel-from-shipped return **409**.
- [ ] `GET /v1/orders/{id}/stream` (SSE) emits `tracking_event` frames in `seq`
      order with `Last-Event-ID` replay; `GET /v1/orders/{id}/tracking` returns the
      authoritative snapshot; `GET /v1/orders/{id}` polling stays current with the stream.
- [ ] `images.ready` from `fake-gen` flows outbox → SSE and swaps `listing.media`
      to `ready`.
- [ ] OpenAPI 3.1 is emitted from Nest decorators and drives the generated SDK;
      no `if (vertical === …)` branch exists in Orders/Search/Cart.
- [ ] `api` and `worker` boot from the **same image**, different entrypoints.
