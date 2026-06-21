# Infra (Stage 1, local Docker)

This directory holds the orchestration glue for the Stage 1 local stack: the
Postgres extension bootstrap and the MinIO bucket bootstrap. The stack itself is
defined at the repo root (`docker-compose.yml`, `docker-compose.override.yml`,
`Makefile`, `.env.example`) and driven through `make`.

```
infra/
  postgres/init/01-extensions.sql   # FTS / pg_trgm, runs once on volume init
  minio/bootstrap.sh                # creates the images bucket + public-read
  README.md                         # this file
```

## How the dev loop works

- **`make up`** -- autocreates `.env` from `.env.example`, builds the images,
  brings the whole stack up, and blocks on `--wait` until every healthcheck is
  green. `migrate` then `seed` run automatically as ordered one-shots inside the
  bring-up, so `make up` alone is the cold start. (`make seed` re-runs the
  idempotent seed on its own.)
- **Hot reload is the default.** `docker-compose.override.yml` is auto-merged on
  top of the base file: the app services (`api`, `worker`, `fake-gen`, `web`)
  run watch-mode commands with bind-mounted source, while the datastores are
  inherited unchanged so your seeded data survives edits. Edit on the host ->
  the container reloads.
- **Prod-parity run** (what CI / Stage 05 build) ignores the overlay:
  `docker compose -f docker-compose.yml up`.
- **`make reset`** wipes the named volumes (`pgdata`, `redisdata`, `miniodata`)
  for a pristine cold start; this also re-triggers the Postgres init script and
  the MinIO bootstrap.
- **One shared image, four roles.** `api`, `worker`, `migrate`, and `seed` all
  run the single `dopamine-api` image, distinguished only by `command:`
  (`api` | `worker` | `migrate` | `seed`), dispatched by
  `apps/api/docker-entrypoint.sh`. Build once, run four ways.
- **Startup ordering** is deterministic: datastores gate everything via
  `service_healthy`; `api`/`worker` additionally wait on `migrate` completing;
  `seed` waits on `migrate` + `minio-init`; `web` waits on `api` healthy.

Handy targets: `make ps` (health at a glance), `make logs`, `make psql`,
`make mc ARGS="ls local/listing-images"`, `make migrate`, `make sdk`.

## Local -> managed mapping (Stage 05 is a swap, not a rewrite)

Every local choice here is an **env / adapter swap** away from its managed
target. Nothing in the application code branches on "local vs cloud".

| Stage 1 (local Docker)              | Stage 05 (managed)                       | What actually changes                                  | Behind which seam            |
|-------------------------------------|------------------------------------------|--------------------------------------------------------|------------------------------|
| `postgres:16` container             | **Neon** Postgres (+ pgvector in St. 02) | `DATABASE_URL`                                         | Prisma datasource URL        |
| `infra/postgres/init` extensions    | Neon-enabled extensions                  | provisioned in Neon (same `CREATE EXTENSION` SQL)      | migration / init SQL         |
| MinIO + `minio-init` bucket         | **Cloudflare R2 + CDN** (zero egress)    | `S3_ENDPOINT`, keys, `S3_PUBLIC_BASE_URL`             | S3 client config             |
| `redis:7` container                 | **Upstash** Redis                        | `REDIS_URL`                                            | Redis client URL             |
| Redis pub/sub SSE fan-out           | **Ably** (or keep self-hosted Redis)     | realtime transport                                    | realtime adapter             |
| `fake-gen` container                | **real generation service** (Stage 02)   | swap one container                                    | `GenerationProvider` HTTP    |
| `docker-compose`                    | **Fly / Render** (api+worker) + **Vercel** (web) | deploy targets -- the images are identical    | image is unchanged           |
| `api`/`worker` shared image         | same image, two Fly processes            | -- (already split by entrypoint command)              | docker-entrypoint role arg   |
| `.env` (committed local defaults)   | platform secrets / secrets manager       | secret source                                         | env injection                |

The load-bearing choices that make each swap env-only:

- **S3 API everywhere** -- MinIO and R2 differ only by env, never code. Both use
  `S3_FORCE_PATH_STYLE=true`.
- **One shared `api`/`worker` image** -- Fly/Render run the same image with the
  `api` vs `worker` command; no repackaging.
- **`fake-gen` isolated behind HTTP** (`FAKEGEN_URL`) -- Stage 02 replaces one
  container, `api` untouched.
- **Every datastore reached via a single URL env var** -- `DATABASE_URL`,
  `REDIS_URL`, `S3_ENDPOINT` -- so managed endpoints drop straight in.
