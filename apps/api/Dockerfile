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
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json    packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/api/package.json           apps/api/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@dopamine/api..."

# Compiled output + Prisma assets (schema + migrations are needed at runtime
# for `prisma migrate deploy`; .prisma is the generated client).
COPY --from=build /repo/apps/api/dist                   apps/api/dist
COPY --from=build /repo/apps/api/prisma                 apps/api/prisma
COPY --from=build /repo/apps/api/node_modules/.prisma   apps/api/node_modules/.prisma
COPY --from=build /repo/packages/contracts/dist         packages/contracts/dist

COPY apps/api/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && groupadd -r app && useradd -r -g app app
USER app
WORKDIR /repo/apps/api

# default role = api server; compose overrides `command:` for worker/migrate/seed
ENTRYPOINT ["entrypoint.sh"]
CMD ["api"]
