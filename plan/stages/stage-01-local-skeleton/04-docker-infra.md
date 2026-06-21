# Stage 01 · 04 — Docker Infrastructure & Local Developer Experience

> **Workstream:** Infra / Developer-Experience. **Owns:** the docker-compose
> orchestration, the shared `api`/`worker` image, MinIO + Redis + Postgres
> wiring, healthchecks & startup ordering, the migrate/seed one-shot, the `.env`
> strategy, the `Makefile` task DX, and the local→managed mapping that keeps
> Stage 05 a swap rather than a rewrite.
>
> **Conforms to:** the Stage 1 charter [`README.md`](README.md) §2 (container
> topology) and §3 (local tech choices), which this doc implements verbatim.
> **Realizes locally** the managed targets in architecture
> [`05-infrastructure-and-cost.md`](../../../docs/architecture/05-infrastructure-and-cost.md).
>
> **Scope:** local Docker only. No managed services, no cloud, **no real
> external API keys** — `fake-gen` stands in for Anthropic + the image provider,
> MinIO for R2, plain Postgres for Neon, a Redis container for Upstash.

---

## 0. What "done" means for this doc

A reviewer clones the repo and runs **two commands**:

```bash
make up          # build images, bring the stack up, run migrate + seed
make seed        # (idempotent re-seed; folded into `make up` but available alone)
```

…and gets the full charter §6 acceptance demo working against `localhost:3000`
with **zero secrets configured** beyond the committed defaults. Every container
reports healthy; the stack comes up in a deterministic order; tearing it down
and wiping volumes (`make reset`) returns to a clean slate.

This doc is the orchestration glue. It does **not** own application code — it
references the siblings that do:

| Sibling | This doc depends on it for |
|---|---|
| [`01-backend-api.md`](01-backend-api.md) | The `api`/`worker` codebase, the Prisma schema + `migrate deploy` + seed script, the BullMQ worker entrypoint, the env vars the backend reads. |
| [`02-fake-generation.md`](02-fake-generation.md) | The `fake-gen` service image, its HTTP contract, and that it writes placeholder images **into MinIO** via the S3 API. |
| [`03-web-frontend.md`](03-web-frontend.md) | The `web` (Next.js) image and the single public env var it needs to reach `api`. |
| [`05-contracts-and-sdk.md`](05-contracts-and-sdk.md) | The pnpm monorepo layout and the SDK-generation step wired into `make sdk`. |

---

## 1. Monorepo layout (the bits this doc touches)

Per charter §3 (pnpm workspaces, `apps/*` + `packages/*`). Infra files live at
the repo root and inside each app:

```
blank-check/
├─ docker-compose.yml            # ← this doc: the canonical stack
├─ docker-compose.override.yml   # ← this doc: dev hot-reload overlay (auto-loaded)
├─ Makefile                      # ← this doc: the task DX
├─ .env.example                  # ← this doc: committed, zero real keys
├─ .env                          # ← this doc: local-only, gitignored, copied from .example
├─ infra/
│  ├─ postgres/init/
│  │  └─ 01-extensions.sql       # ← this doc: FTS / pg_trgm bootstrap
│  └─ minio/
│     └─ bootstrap.sh            # ← this doc: bucket + public-read policy
├─ apps/
│  ├─ api/                       # NestJS — owns Dockerfile (shared api+worker), entrypoints
│  │  ├─ Dockerfile
│  │  ├─ docker-entrypoint.sh
│  │  └─ prisma/ (schema + migrations + seed)   ← owned by 01-backend-api.md
│  ├─ fake-gen/                  # standalone HTTP svc — owns its Dockerfile  ← 02-fake-generation.md
│  │  └─ Dockerfile
│  └─ web/                       # Next.js — owns its Dockerfile  ← 03-web-frontend.md
│     └─ Dockerfile
└─ packages/
   ├─ contracts/                 # Zod + OpenAPI types  ← 05-contracts-and-sdk.md
   └─ sdk/                       # generated TS client  ← 05-contracts-and-sdk.md
```

The `api` and `worker` services **share one image built from `apps/api`** — one
codebase, two entrypoints (§3). `fake-gen` and `web` each have their own
Dockerfile. All three app Dockerfiles build from the monorepo root as context so
pnpm can resolve `packages/*`.

---

## 2. Container set (charter §2)

Eight long-lived/one-shot units, exactly as the charter topology dictates:

| Service | Image | Port(s) | Kind | Managed swap (Stage 05) |
|---|---|---|---|---|
| `web` | `apps/web` (Next.js) | `3000` | long-lived | Vercel |
| `api` | `apps/api` (NestJS) | `8080` | long-lived | Fly/Render |
| `worker` | **same image as `api`** | — | long-lived | Fly/Render worker |
| `fake-gen` | `apps/fake-gen` | `8090` | long-lived | real generation service (Stage 02) |
| `postgres` | `postgres:16` (plain) | `5432` | stateful | Neon (+ pgvector in Stage 02) |
| `redis` | `redis:7` | `6379` | stateful | Upstash |
| `minio` | `minio/minio` | `9000` (S3) / `9001` (console) | stateful | Cloudflare R2 + CDN |
| `minio-bootstrap` | `minio/mc` | — | **one-shot** | (n/a — R2 bucket via IaC) |
| `migrate` | same image as `api` | — | **one-shot** | runs in CI on deploy |
| `seed` | same image as `api` | — | **one-shot** | seed job / data migration |

`worker`, `migrate`, and `seed` all reuse the `api` image with a different
`command` — no extra images to build. `postgres` is **plain Postgres 16, NOT
pgvector** — pgvector arrives with semantic dedup in **Stage 02** (per its README:
"add pgvector to the Postgres image"); Stage 1 needs only FTS + `pg_trgm`.

---

## 3. The shared `api`/`worker` image — one Dockerfile, two entrypoints

NestJS app, multi-stage build. The trick: the **same image** runs as the API
HTTP server *or* as the BullMQ worker, selected by the compose `command`. An
entrypoint script also runs migrate/seed for the one-shot jobs.

`apps/api/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7

# ---- base: pnpm + node, monorepo-aware ----
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /repo

# ---- deps: install once, cached on lockfile ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/sdk/package.json       packages/sdk/
COPY apps/api/package.json           apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @bc/api... --filter @bc/contracts

# ---- build: compile NestJS + generate Prisma client ----
FROM deps AS build
COPY packages/contracts packages/contracts
COPY apps/api           apps/api
RUN pnpm --filter @bc/contracts build \
 && pnpm --filter @bc/api exec prisma generate \
 && pnpm --filter @bc/api build           # -> apps/api/dist

# ---- runtime: prod deps only, non-root ----
FROM base AS runtime
ENV NODE_ENV=production
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @bc/api... --filter @bc/contracts
# built artifacts + prisma (schema/migrations needed for `migrate deploy` & seed)
COPY --from=build /repo/apps/api/dist            apps/api/dist
COPY --from=build /repo/apps/api/prisma          apps/api/prisma
COPY --from=build /repo/apps/api/node_modules/.prisma apps/api/node_modules/.prisma
COPY --from=build /repo/packages/contracts/dist  packages/contracts/dist
COPY apps/api/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && groupadd -r app && useradd -r -g app app
USER app
WORKDIR /repo/apps/api

# default = API server; compose overrides `command` for the other roles
ENTRYPOINT ["entrypoint.sh"]
CMD ["api"]
```

`apps/api/docker-entrypoint.sh` — the single switchboard for all four roles:

```sh
#!/bin/sh
set -e
ROLE="${1:-api}"
case "$ROLE" in
  api)     exec node dist/main.js ;;                     # NestJS HTTP server :8080
  worker)  exec node dist/worker.js ;;                   # BullMQ consumer (no HTTP port)
  migrate) exec pnpm exec prisma migrate deploy ;;       # apply migrations, then exit 0
  seed)    exec node dist/seed.js ;;                      # load starter retail catalog, exit 0
  *) echo "unknown role: $ROLE" >&2; exit 1 ;;
esac
```

- `dist/main.js` and `dist/worker.js` are the two entrypoints from
  [`01-backend-api.md`](01-backend-api.md) — same DI container, but `worker.js`
  boots only the BullMQ processors (fulfillment ticker + generation enrichment),
  no HTTP listener.
- `migrate`/`seed` are short-lived: they run, exit 0, and gate dependents via
  `depends_on: service_completed_successfully` (§6).

> **Why share the image?** The charter is explicit: "`worker` and `api` share one
> Docker image with different entrypoints (one codebase)." Build once, run four
> ways. This also guarantees `migrate`/`seed` run the *exact* Prisma client the
> API uses — no version skew.

### `fake-gen` Dockerfile (separate, tiny — `apps/fake-gen/Dockerfile`)

Kept deliberately standalone so **Stage 02 replaces only this container** with the
real pipeline, untouched `api`:

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/fake-gen/package.json      apps/fake-gen/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @bc/fake-gen... --filter @bc/contracts
COPY packages/contracts packages/contracts
COPY apps/fake-gen      apps/fake-gen
RUN pnpm --filter @bc/contracts build && pnpm --filter @bc/fake-gen build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
RUN groupadd -r app && useradd -r -g app app
USER app
WORKDIR /repo/apps/fake-gen
EXPOSE 8090
CMD ["node", "dist/main.js"]
```

`fake-gen` writes its placeholder images to MinIO via the same S3 client config
as `api` (§5) — see [`02-fake-generation.md`](02-fake-generation.md) for the
generation contract and image production.

### `web` Dockerfile (Next.js standalone — `apps/web/Dockerfile`)

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH" NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/sdk/package.json       packages/sdk/
COPY apps/web/package.json           apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @bc/web... --filter @bc/sdk --filter @bc/contracts
COPY . .
RUN pnpm --filter @bc/contracts build \
 && pnpm --filter @bc/sdk build \
 && pnpm --filter @bc/web build            # next build, output: "standalone"

FROM base AS runtime
ENV NODE_ENV=production
RUN groupadd -r app && useradd -r -g app app
USER app
WORKDIR /repo/apps/web
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static     ./apps/web/.next/static
COPY --from=build /repo/apps/web/public            ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
```

---

## 4. The full `docker-compose.yml`

This is the canonical production-shaped stack (the dev hot-reload overlay is §9).
Healthchecks + ordered `depends_on` make the cold start deterministic (§6).

```yaml
name: blank-check

x-app-env: &app-env
  DATABASE_URL: postgresql://app:app@postgres:5432/blankcheck?schema=public
  REDIS_URL: redis://redis:6379
  S3_ENDPOINT: http://minio:9000
  S3_REGION: us-east-1
  S3_BUCKET: ${S3_BUCKET:-listing-images}
  S3_ACCESS_KEY_ID: ${MINIO_ROOT_USER:-minioadmin}
  S3_SECRET_ACCESS_KEY: ${MINIO_ROOT_PASSWORD:-minioadmin}
  S3_FORCE_PATH_STYLE: "true"            # MinIO needs path-style; R2 too
  S3_PUBLIC_BASE_URL: ${S3_PUBLIC_BASE_URL:-http://localhost:9000/listing-images}
  FAKE_GEN_URL: http://fake-gen:8090
  NODE_ENV: production

services:
  # ---------- datastores ----------
  postgres:
    image: postgres:16                    # plain — pgvector is Stage 02
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: blankcheck
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./infra/postgres/init:/docker-entrypoint-initdb.d:ro   # FTS / pg_trgm
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d blankcheck"]
      interval: 5s
      timeout: 3s
      retries: 10
    networks: [backend]

  redis:
    image: redis:7
    command: ["redis-server", "--appendonly", "yes"]
    ports: ["6379:6379"]
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
    networks: [backend]

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-minioadmin}
    ports:
      - "9000:9000"     # S3 API
      - "9001:9001"     # web console
    volumes:
      - miniodata:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 3s
      retries: 10
    networks: [backend]

  # ---------- one-shot bootstraps ----------
  minio-bootstrap:                        # create bucket + public-read policy, then exit
    image: minio/mc
    depends_on:
      minio: { condition: service_healthy }
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-minioadmin}
      S3_BUCKET: ${S3_BUCKET:-listing-images}
    entrypoint: ["/bin/sh", "/bootstrap.sh"]
    volumes:
      - ./infra/minio/bootstrap.sh:/bootstrap.sh:ro
    networks: [backend]

  migrate:                                # prisma migrate deploy, then exit 0
    image: bc-api                         # built from apps/api below
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    command: ["migrate"]
    environment: *app-env
    depends_on:
      postgres: { condition: service_healthy }
    networks: [backend]

  seed:                                   # load starter retail catalog, exit 0
    image: bc-api
    command: ["seed"]
    environment: *app-env
    depends_on:
      migrate: { condition: service_completed_successfully }
      minio-bootstrap: { condition: service_completed_successfully }
    networks: [backend]

  # ---------- application services ----------
  api:
    image: bc-api
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    command: ["api"]
    environment:
      <<: *app-env
      PORT: "8080"
      CORS_ORIGIN: http://localhost:3000
    ports: ["8080:8080"]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
      minio: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8080/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 12
    networks: [backend]

  worker:                                 # same image, BullMQ entrypoint
    image: bc-api
    command: ["worker"]
    environment: *app-env
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "node", "-e", "process.exit(0)"]    # liveness placeholder; see note
      interval: 10s
      timeout: 3s
      retries: 6
    networks: [backend]

  fake-gen:
    image: bc-fake-gen
    build:
      context: .
      dockerfile: apps/fake-gen/Dockerfile
    command: ["node", "dist/main.js"]
    environment:
      <<: *app-env
      PORT: "8090"
    ports: ["8090:8090"]
    depends_on:
      minio-bootstrap: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8090/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 12
    networks: [backend]

  web:
    image: bc-web
    build:
      context: .
      dockerfile: apps/web/Dockerfile
    environment:
      # Next.js public var: the browser talks to api on the host-published port
      NEXT_PUBLIC_API_BASE_URL: ${NEXT_PUBLIC_API_BASE_URL:-http://localhost:8080}
    ports: ["3000:3000"]
    depends_on:
      api: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 12
    networks: [backend]

volumes:
  pgdata:
  redisdata:
  miniodata:

networks:
  backend:
    driver: bridge
```

Notes:
- **One internal network** (`backend`); services address each other by name
  (`postgres`, `redis`, `minio`, `fake-gen`, `api`). The only ports published to
  the host are the ones a developer/browser touches (web:3000, api:8080,
  fake-gen:8090 for debugging, plus the datastore ports for tooling).
- **`worker` has no HTTP port**, so its healthcheck is a liveness placeholder.
  The real readiness signal for the worker is that BullMQ connects to Redis; if
  [`01-backend-api.md`](01-backend-api.md) exposes a tiny `/healthz` on the
  worker (recommended), swap the placeholder for a real probe.
- `NEXT_PUBLIC_API_BASE_URL` is `http://localhost:8080` because it's baked for
  the **browser**, which resolves against the host, not the compose network. SSR
  fetches inside `web` could use `http://api:8080` via a separate server-only var
  if [`03-web-frontend.md`](03-web-frontend.md) does server-side data fetching.

---

## 5. Per-datastore wiring

### 5.1 Postgres — plain 16, FTS + `pg_trgm` (no pgvector yet)

The init script runs once on first volume creation. It enables only what Stage 1
needs per charter §3 ("FTS + `pg_trgm`. **No pgvector yet**").

`infra/postgres/init/01-extensions.sql`:

```sql
-- Stage 1: full-text search + fuzzy/trigram matching only.
-- pgvector is added in Stage 02 (semantic dedup). Do NOT add it here.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;   -- accent-insensitive FTS
-- (tsvector/FTS is core Postgres — no extension needed.)
```

- The relational schema, `search_doc tsvector` columns, GIN/trigram indexes, and
  migrations are owned by [`01-backend-api.md`](01-backend-api.md) via Prisma —
  this script only provisions the **extensions** the migrations assume exist.
- **Stage 02 swap:** add `CREATE EXTENSION IF NOT EXISTS vector;` here and move to
  a `pgvector/pgvector:pg16` base image. Nothing else in this doc changes.

### 5.2 The migrate + seed one-shot

Two ordered one-shot jobs, both on the shared `api` image:

1. **`migrate`** runs `prisma migrate deploy` (production-safe, applies committed
   migrations — never `migrate dev`), then exits 0.
2. **`seed`** runs `dist/seed.js`, which loads the **starter retail catalog**
   (storefront + categories + seed listings) so the acceptance demo has something
   to browse, then exits 0.

`seed` waits on **both** `migrate` (schema ready) **and** `minio-bootstrap`
(bucket ready) via `service_completed_successfully`, because seed listings may
reference placeholder images in the bucket. The seed script must be **idempotent**
(upsert by stable slug/key) so `make seed` is safe to re-run — see
[`01-backend-api.md`](01-backend-api.md) for the seed implementation.

### 5.3 MinIO — S3-compatible local object storage + bucket bootstrap

MinIO is the local stand-in for Cloudflare R2. A one-shot `minio-bootstrap`
(`minio/mc`) creates the images bucket and applies a **public-read** policy so
the browser can load placeholder images directly by URL (local convenience only).

`infra/minio/bootstrap.sh`:

```sh
#!/bin/sh
set -e
mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "local/${S3_BUCKET}"
# Local-only: anonymous read so the web client can <img src> straight from MinIO.
# In Stage 05 this becomes R2 + Cloudflare CDN with signed/CDN URLs.
mc anonymous set download "local/${S3_BUCKET}"
echo "minio bootstrap complete: bucket=${S3_BUCKET} (public-read)"
```

**S3 client config differs only by env between MinIO and R2** — this is the whole
point of using the S3 API locally:

| Env var | Stage 1 (MinIO) | Stage 05 (R2) |
|---|---|---|
| `S3_ENDPOINT` | `http://minio:9000` | `https://<acct>.r2.cloudflarestorage.com` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `minioadmin` / `minioadmin` | R2 token pair |
| `S3_BUCKET` | `listing-images` | `listing-images` |
| `S3_FORCE_PATH_STYLE` | `true` | `true` (R2 also path-style) |
| `S3_PUBLIC_BASE_URL` | `http://localhost:9000/listing-images` | `https://cdn.example.com` (CDN) |

Both `api` (image ingestion / transactional catalog write) and `fake-gen`
(placeholder image production) use this **same env-driven S3 client** — no
code-level branching, no `if (minio)`. Stage 05 swaps the four env values.

### 5.4 Redis — one container, four jobs

A single `redis:7` container serves **all four** Redis roles per charter §3:

- **Cache** — hot listings, the exact-cache `canon_key → listing_id` for the
  generation seam (charter §4.2).
- **Queue** — BullMQ backing store for the fulfillment ticker + generation
  enrichment jobs the `worker` consumes.
- **Pub/sub** — SSE fan-out so `api` instances broadcast `tracking_event` /
  `images.ready` to subscribers (charter §4.3).
- **Locks** — the generation `SETNX` lock that dedups concurrent identical
  search-misses (charter §4.2).

`--appendonly yes` gives durable queue state across `make down`/`up` (cleared by
`make reset`). One `REDIS_URL` env var; Stage 05 points it at Upstash.

---

## 6. Healthchecks & startup ordering

Cold start must be deterministic — services should not flap or crash-loop while
a dependency boots. The dependency graph:

```
postgres (healthy) ─┬─► migrate (completed) ─┬─► seed (completed)
redis    (healthy) ─┤                        │
minio    (healthy) ─┴─► minio-bootstrap ─────┘ (completed)
                              │
   ┌──────────────────────────┴───────────────────────────┐
   ▼                          ▼                            ▼
 api  (waits: pg+redis+minio healthy, migrate completed)  fake-gen (waits: bootstrap)
   │  └─ healthy ──► web  (waits: api healthy)
 worker (waits: pg+redis healthy, migrate completed)
```

Rules encoded in compose:
- **Datastores gate everything** via `condition: service_healthy` — `api`/`worker`
  never start until `postgres` and `redis` answer `pg_isready` / `PING`.
- **`api`/`worker` additionally wait on `migrate` completing** so they never boot
  against an unmigrated schema (`service_completed_successfully`).
- **`seed` waits on `migrate` + `minio-bootstrap`** completing.
- **`web` waits on `api` being healthy** (`/v1/health` returns ok) so the
  frontend never renders against a cold backend.
- Every long-lived service declares its own `healthcheck` so `make up` can block
  on `--wait` until the whole stack is green.

This realizes the charter requirement that "`docker compose up` brings the whole
system up locally with seed data" reliably, every time.

---

## 7. `.env` strategy — zero real external keys

Stage 1's defining constraint (charter §6): the system runs with **zero real
external API keys**. There is no Anthropic key, no image-provider key, no cloud
credential anywhere — `fake-gen` *is* the generation provider, MinIO *is* the
object store.

- **`.env.example`** — committed. Contains every var with **safe local defaults**.
  A fresh clone works by copying it verbatim; nothing must be filled in by hand.
- **`.env`** — gitignored, created by `cp .env.example .env` (done automatically
  by `make up`). Local overrides only.
- **No secrets** — the only "credentials" are the throwaway MinIO root
  user/password (`minioadmin`/`minioadmin`) and the local Postgres password
  (`app`), none of which protect anything real.

`.env.example` (committed):

```dotenv
# ---- shared infra (used by api, worker, fake-gen, migrate, seed) ----
DATABASE_URL=postgresql://app:app@postgres:5432/blankcheck?schema=public
REDIS_URL=redis://redis:6379

# ---- object storage (MinIO locally; R2 in Stage 05 — swap these four) ----
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=listing-images
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_BASE_URL=http://localhost:9000/listing-images
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin

# ---- generation seam (fake-gen replaces Anthropic + image provider) ----
FAKE_GEN_URL=http://fake-gen:8090

# ---- api ----
PORT=8080
CORS_ORIGIN=http://localhost:3000

# ---- web (NEXT_PUBLIC_* is baked for the browser → host-published api port) ----
NEXT_PUBLIC_API_BASE_URL=http://localhost:8080

# ---- NOTE: Stage 1 needs NO real keys. The following are intentionally absent:
#   ANTHROPIC_API_KEY      (added Stage 02)
#   IMAGE_PROVIDER_API_KEY (added Stage 02)
#   R2/Neon/Upstash creds  (added Stage 05)
```

Per-service env requirements (which vars each container reads):

| Service | Env vars it consumes |
|---|---|
| `postgres` | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` (literals in compose) |
| `redis` | — (config via `command`) |
| `minio` | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` |
| `minio-bootstrap` | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_BUCKET` |
| `migrate` | `DATABASE_URL` |
| `seed` | `DATABASE_URL`, `S3_*` (placeholder images), `S3_PUBLIC_BASE_URL` |
| `api` | `DATABASE_URL`, `REDIS_URL`, `S3_*`, `FAKE_GEN_URL`, `PORT`, `CORS_ORIGIN` |
| `worker` | `DATABASE_URL`, `REDIS_URL`, `S3_*`, `FAKE_GEN_URL` |
| `fake-gen` | `S3_*`, `S3_PUBLIC_BASE_URL`, `PORT` |
| `web` | `NEXT_PUBLIC_API_BASE_URL` |

---

## 8. Makefile — the task DX (one-command cold start)

The DX target from charter §6: clone → `make up && make seed` → working app.
`make up` already runs migrate+seed via compose dependencies, so in practice
`make up` alone is the cold start; `make seed` is exposed for re-seeding.

`Makefile`:

```makefile
COMPOSE := docker compose
SHELL   := /bin/bash

.PHONY: up down seed migrate logs reset sdk build ps

# Cold start: ensure .env, build images, bring everything up, wait for healthy.
# migrate + seed run automatically as ordered one-shots inside the stack.
up: .env
	$(COMPOSE) up -d --build --wait
	@echo "✅ stack up — web http://localhost:3000  ·  api http://localhost:8080  ·  minio http://localhost:9001"

# Create local .env from the committed example on first run.
.env:
	cp .env.example .env
	@echo "created .env from .env.example (zero real keys needed)"

down:
	$(COMPOSE) down

# Re-run the idempotent seed one-shot against the running stack.
seed:
	$(COMPOSE) run --rm seed

# Apply migrations without a full restart (e.g. after pulling new migrations).
migrate:
	$(COMPOSE) run --rm migrate

logs:
	$(COMPOSE) logs -f --tail=200

# Nuke everything including volumes — back to a clean slate.
reset:
	$(COMPOSE) down -v --remove-orphans
	@echo "🧹 volumes wiped (pgdata, redisdata, miniodata)"

# Regenerate the typed SDK from the OpenAPI spec (see 05-contracts-and-sdk.md).
sdk:
	pnpm --filter @bc/sdk generate
	@echo "📦 SDK regenerated from /v1 OpenAPI spec"

build:
	$(COMPOSE) build

ps:
	$(COMPOSE) ps
```

- **`make up`** — `.env` autocreated, images built, `--wait` blocks until all
  healthchecks pass; migrate+seed run as part of the ordered bring-up.
- **`make down`** — stop containers, keep volumes (fast restart).
- **`make reset`** — `down -v`: wipe all named volumes for a pristine cold start.
- **`make seed` / `make migrate`** — re-run the one-shots on demand.
- **`make logs`** — tail everything; **`make ps`** — health at a glance.
- **`make sdk`** — regenerate the typed client from the `/v1` OpenAPI spec
  (owned by [`05-contracts-and-sdk.md`](05-contracts-and-sdk.md)); run after the
  backend changes the contract, before rebuilding `web`.

---

## 9. Dev vs prod compose — hot-reload for fast iteration

The base `docker-compose.yml` (§4) is production-shaped (built images, no source
mounts). For day-to-day backend/frontend iteration, an **override file**
(auto-merged by `docker compose`) swaps the app services to a `dev` build target
with bind-mounted source + watch-mode commands. The datastores are unchanged, so
you keep your seeded data while iterating on code.

`docker-compose.override.yml` (auto-loaded; gives hot reload):

```yaml
services:
  api:
    build:
      target: deps                     # use the dep stage; run source via ts-node-dev
    command: ["pnpm", "--filter", "@bc/api", "dev"]   # nest start --watch
    volumes:
      - ./apps/api:/repo/apps/api
      - ./packages:/repo/packages
      - /repo/apps/api/node_modules    # keep container's node_modules
    environment:
      NODE_ENV: development

  worker:
    build:
      target: deps
    command: ["pnpm", "--filter", "@bc/api", "dev:worker"]
    volumes:
      - ./apps/api:/repo/apps/api
      - ./packages:/repo/packages
      - /repo/apps/api/node_modules

  fake-gen:
    build:
      target: build
    command: ["pnpm", "--filter", "@bc/fake-gen", "dev"]
    volumes:
      - ./apps/fake-gen:/repo/apps/fake-gen
      - ./packages:/repo/packages
      - /repo/apps/fake-gen/node_modules

  web:
    build:
      target: build
    command: ["pnpm", "--filter", "@bc/web", "dev"]   # next dev
    volumes:
      - ./apps/web:/repo/apps/web
      - ./packages:/repo/packages
      - /repo/apps/web/node_modules
    environment:
      NODE_ENV: development
```

- **Bind mounts + watch** (`nest start --watch`, `next dev`) → edit on the host,
  the container reloads. The anonymous `node_modules` volume prevents the host
  from shadowing the container's installed deps.
- **`docker compose -f docker-compose.yml up`** (explicitly, ignoring the
  override) runs the **prod-shaped** stack — what CI/Stage 05 will build. Document
  both: `make up` (dev, default) vs an explicit prod compose for parity checks.
- Compose's native **`develop.watch`** (file-sync + rebuild triggers) is an
  alternative to bind mounts if the team prefers it; either satisfies the
  fast-iteration requirement. Bind mounts shown here for the lowest setup cost.

---

## 10. Local → managed mapping (Stage 05 is a swap, not a rewrite)

Every local choice in this doc is an **env/adapter swap** away from its managed
target. This table reaffirms the charter §2 mapping and the Stage 05 README's
"each swap is a one-container/one-adapter change":

| Stage 1 (local Docker) | Stage 05 (managed) | What actually changes | Behind which seam |
|---|---|---|---|
| `postgres:16` container | **Neon** Postgres (+pgvector) | `DATABASE_URL` | Prisma datasource URL |
| `infra/postgres/init` extensions | Neon-enabled extensions | (provisioned in Neon) | migration / SQL |
| MinIO + `minio-bootstrap` | **Cloudflare R2 + CDN** | `S3_ENDPOINT`, keys, `S3_PUBLIC_BASE_URL` | S3 client config |
| `redis:7` container | **Upstash** Redis | `REDIS_URL` | Redis client URL |
| Redis pub/sub SSE fan-out | **Ably** (or keep Redis) | realtime transport | realtime adapter |
| `fake-gen` container | **real generation service** | swap one container | `GenerationProvider` HTTP (Stage 02) |
| `docker-compose` | **Fly/Render** (api+worker) + **Vercel** (web) | deploy targets | image is identical |
| `api`/`worker` shared image | same image, two Fly processes | — | already split by entrypoint |
| `.env` (committed defaults) | platform secrets / SSM | secret source | env injection |

The load-bearing design choices that make this true:
- **S3 API everywhere** — MinIO and R2 differ only by env, never code.
- **One shared `api`/`worker` image** — Fly/Render just run the same image with
  the `api` vs `worker` command; no repackaging.
- **`fake-gen` isolated behind HTTP** — Stage 02 replaces one container, `api`
  untouched (confirmed by the Stage 02 README).
- **All connections via single URL env vars** — `DATABASE_URL`, `REDIS_URL`,
  `S3_ENDPOINT` — so managed endpoints drop in.

---

## 11. Exit checklist

Stage 1 infra is **done** when all of the following hold:

- [ ] **One-command cold start works.** From a clean clone with no `.env`,
      `make up` (which autocreates `.env`, builds images, runs migrate+seed) brings
      the entire stack up and `--wait` returns green; the charter §6 acceptance
      demo passes against `http://localhost:3000`.
- [ ] **`make up && make seed`** reproduces the documented DX path; `make seed`
      is idempotent (safe to re-run).
- [ ] **Zero real external keys.** No `ANTHROPIC_API_KEY`, no image-provider key,
      no cloud credential exists anywhere; `fake-gen` + MinIO are fully
      self-contained. `.env.example` is committed and works verbatim.
- [ ] **All healthchecks green.** `make ps` shows `postgres`, `redis`, `minio`,
      `api`, `fake-gen`, `web`, `worker` healthy; `migrate`, `seed`, and
      `minio-bootstrap` exited 0.
- [ ] **Startup ordering holds** — `api`/`worker` never boot before
      postgres+redis healthy and migrate completed; `seed` waits for migrate +
      bucket bootstrap; `web` waits for `api` healthy.
- [ ] **Eight units present** per charter §2: `web`, `api`, `worker`, `fake-gen`,
      `postgres`, `redis`, `minio` + the migrate/seed one-shot (and the
      minio-bootstrap one-shot).
- [ ] **Shared image confirmed** — `api`, `worker`, `migrate`, `seed` all run the
      single `bc-api` image, distinguished only by `command`.
- [ ] **Postgres is plain 16** with `pg_trgm`/FTS only — **no pgvector** (that's
      Stage 02), with the extension swap documented.
- [ ] **MinIO bucket** `listing-images` exists with public-read; `api` and
      `fake-gen` read/write it via the same env-driven S3 client.
- [ ] **`make reset`** wipes all volumes and returns to a pristine cold start.
- [ ] **`make sdk`** regenerates the SDK from the `/v1` spec.
- [ ] **Local→managed mapping** documented (§10) — every swap is env/adapter only.
- [ ] **Hot reload** works via the override compose for fast local iteration.
