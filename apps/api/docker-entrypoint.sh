#!/bin/sh
# Single switchboard for the shared api image. The first arg selects the role;
# compose passes it via `command:`. Default (from the Dockerfile CMD) is "api".
#
#   api      -> NestJS HTTP server on :8080 (long-lived)
#   worker   -> BullMQ consumer, no HTTP port (long-lived)
#   migrate  -> prisma migrate deploy, then exit 0 (one-shot)
#   seed     -> load starter retail catalog, then exit 0 (one-shot)
#
# api/worker are two entrypoints over one DI container (dist/main.js vs
# dist/worker.js) -- see 01-backend-api.md. migrate/seed gate dependents via
# `depends_on: { condition: service_completed_successfully }`.
set -e

ROLE="${1:-api}"

case "$ROLE" in
  api)
    exec node dist/main.js
    ;;
  worker)
    exec node dist/worker.js
    ;;
  migrate)
    # production-safe: applies committed migrations only (never `migrate dev`).
    # Invoke the prisma CLI DIRECTLY (copied into the image), not via
    # `pnpm exec` — that would make corepack try to download a package manager at
    # container start, which fails as the non-root `app` user. node_modules/.bin
    # resolves the workspace-linked prisma bin.
    exec ./node_modules/.bin/prisma migrate deploy
    ;;
  seed)
    # idempotent: upserts by stable slug/key so `make seed` is re-runnable.
    exec node dist/seed.js
    ;;
  *)
    echo "docker-entrypoint: unknown role '$ROLE' (want: api|worker|migrate|seed)" >&2
    exit 1
    ;;
esac
