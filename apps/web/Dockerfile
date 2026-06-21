# syntax=docker/dockerfile:1.7
#
# web (Next.js App Router) -- multi-stage standalone build.
#
#   Build context MUST be the repo root (`context: .` in compose) so pnpm can
#   resolve packages/* (contracts + the generated sdk) from the workspace.
#
#   Requires `output: "standalone"` in apps/web/next.config -- it emits a
#   self-contained server bundle (apps/web/.next/standalone) with a minimal
#   node_modules, so the runtime stage carries no pnpm/workspace at all.
#
# Pins: node 22, pnpm via corepack pinned to the root packageManager.

# ---- base ------------------------------------------------------------------
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# ---- deps: install on manifests only (cache-friendly) ----------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json    packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/web/package.json           apps/web/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@dopamine/web..."

# ---- build: contracts -> sdk (if present) -> next build --------------------
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter "@dopamine/contracts" build \
 && pnpm --filter "@dopamine/web" build

# ---- runtime: standalone server, non-root ----------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN groupadd -r app && useradd -r -g app app
WORKDIR /repo/apps/web

# standalone bundle, static assets, and public/ -- the three pieces Next needs.
COPY --from=build --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/web/.next/static     ./apps/web/.next/static
COPY --from=build --chown=app:app /repo/apps/web/public           ./apps/web/public

USER app
EXPOSE 3000
# the standalone bundle re-creates the workspace path; server.js sits under it.
CMD ["node", "apps/web/server.js"]
