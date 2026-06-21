# syntax=docker/dockerfile:1.7
#
# Shared api + worker image (one codebase, four roles).
#
#   Build context MUST be the repo root (`context: .` in compose) so pnpm can
#   resolve the workspace packages under packages/*.
#
#   The SAME image runs as: api server | BullMQ worker | migrate one-shot |
#   seed one-shot -- selected by the first CMD arg, dispatched by
#   docker-entrypoint.sh. See that script for the switchboard.
#
# Pins: node 22 (prod runtime parity), pnpm via corepack pinned to the
# packageManager field in the root package.json (no floating pnpm).

# ---- base: pnpm + node, monorepo-aware -------------------------------------
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
# OpenSSL 3 must be present in EVERY stage that installs deps OR runs prisma:
# the @prisma/engines postinstall picks its engine variant by the libssl version
# it detects AT INSTALL TIME. Without openssl here it downloads the openssl-1.1.x
# engines, but the runtime resolves debian-openssl-3.0.x → "schema-engine not
# found". Installing it in the shared base keeps deps + build + runtime aligned.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# corepack ships with node; `prepare --activate` pins pnpm to package.json's
# packageManager so the in-image pnpm matches the committed lockfile.
RUN corepack enable
WORKDIR /repo

# ---- deps: install workspace deps, cached on the lockfile ------------------
# Copy only manifests first so this layer is reused until a package.json or the
# lockfile actually changes.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json    packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/api/package.json           apps/api/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@dopamine/api..."

# ---- build: compile + generate the Prisma client ---------------------------
FROM deps AS build
COPY packages packages
COPY apps/api apps/api
# contracts must build first (api depends on it); then generate the Prisma
# client and compile the Nest app to apps/api/dist.
RUN pnpm --filter "@dopamine/contracts" build \
 && pnpm --filter "@dopamine/api" exec prisma generate \
 && pnpm --filter "@dopamine/api" build

# ---- runtime: prod deps only, non-root -------------------------------------
# Re-install with --prod for a lean node_modules, then copy in the compiled
# artifacts. `pnpm deploy` is the leaner alternative once the api app exists;
# the manifest-driven prod install keeps the workspace symlinks Prisma needs.
FROM base AS runtime
ENV NODE_ENV=production
# (OpenSSL 3 + ca-certificates are inherited from the base stage.)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json    packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/api/package.json           apps/api/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@dopamine/api..."

# Compiled output + Prisma assets (schema + migrations are needed at runtime
# for `prisma migrate deploy`).
COPY --from=build /repo/apps/api/dist                   apps/api/dist
COPY --from=build /repo/apps/api/prisma                 apps/api/prisma
COPY --from=build /repo/packages/contracts/dist         packages/contracts/dist

# Prisma generated client (default output): under pnpm it lands in the STORE-
# backed dir beside the @prisma/client package, NOT under apps/api. The prod
# install above re-creates the @prisma/client symlink but NOT the generated
# client + native engine, so overlay both from the build stage. The .pnpm path
# is hash-stable within a build (same lockfile → same hash in build & runtime).
# `@prisma/client` resolves `.prisma/client` from here at runtime; the schema's
# binaryTargets put the debian-openssl-3.0.x engine in this dir for node:22-slim.
COPY --from=build \
  /repo/node_modules/.pnpm/@prisma+client@6.2.1_prisma@6.2.1/node_modules/.prisma \
  /repo/node_modules/.pnpm/@prisma+client@6.2.1_prisma@6.2.1/node_modules/.prisma

# The `migrate` role runs `prisma migrate deploy`, which needs the prisma CLI.
# `--prod` strips it (it's a devDependency), so copy the CLI + its workspace
# deps from the build stage. This keeps the migrate one-shot self-contained
# without re-adding a network/corepack download at container start.
COPY --from=build /repo/node_modules/.pnpm/prisma@6.2.1 \
                  /repo/node_modules/.pnpm/prisma@6.2.1
COPY --from=build /repo/node_modules/.pnpm/@prisma+engines@6.2.1 \
                  /repo/node_modules/.pnpm/@prisma+engines@6.2.1
COPY --from=build /repo/apps/api/node_modules/prisma /repo/apps/api/node_modules/prisma
COPY --from=build /repo/apps/api/node_modules/.bin/prisma /repo/apps/api/node_modules/.bin/prisma

COPY apps/api/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
# A real, writable HOME for the non-root `app` user: prisma/node write a cache
# there, and corepack/pnpm need a writable dir (the default /home/app is not
# writable to a `useradd -r` system user otherwise). Pre-activate pnpm so the
# migrate one-shot never tries to DOWNLOAD a package manager at container start
# (that fails offline + as non-root) — the run is fully self-contained.
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && groupadd -r app && useradd -r -g app -m -d /home/app app \
 && corepack prepare --activate \
 && mkdir -p /home/app/.cache && chown -R app:app /home/app \
 # The prisma CLI verifies/locates the query engine inside @prisma/engines at
 # run time and needs that dir writable; the copied store dirs are root-owned, so
 # hand them (+ the prisma CLI pkg) to `app`. Without this the `migrate` one-shot
 # dies with "Can't write to .../@prisma/engines".
 && chown -R app:app \
      /repo/node_modules/.pnpm/@prisma+engines@6.2.1 \
      /repo/node_modules/.pnpm/prisma@6.2.1 \
      /repo/apps/api/node_modules/prisma
# PRISMA_ENGINES_MIRROR is unused (engines are baked in via binaryTargets); set a
# writable cache home so any prisma CLI bookkeeping has somewhere to go.
ENV HOME=/home/app \
    PRISMA_CLI_BINARY_TARGETS=debian-openssl-3.0.x
USER app
WORKDIR /repo/apps/api

# default role = api server; compose overrides `command:` for worker/migrate/seed
ENTRYPOINT ["entrypoint.sh"]
CMD ["api"]
