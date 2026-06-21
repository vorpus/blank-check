# syntax=docker/dockerfile:1
#
# fake-gen — multi-stage build. BUILD CONTEXT = REPO ROOT (the service needs the
# pnpm workspace + @dopamine/contracts). The compose service is:
#   build: { context: ., dockerfile: apps/fake-gen/Dockerfile }
#   service name: fake-gen, port 8090
#
# Stage layout:
#   base    — pinned node + pnpm (corepack)
#   build   — install the whole workspace, build contracts + fake-gen, then
#             `pnpm deploy` a slim, self-contained node_modules for the runtime
#   runtime — distroless-ish slim node image with only dist/ + prod node_modules

# ---- base ------------------------------------------------------------------
FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI=1
RUN corepack enable
WORKDIR /repo

# ---- build -----------------------------------------------------------------
FROM base AS build

# Copy just the manifests first for a cacheable install layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json ./
COPY packages/config/package.json   packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/fake-gen/package.json      apps/fake-gen/package.json

# Full install (workspace) — frozen lockfile for reproducibility.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Now the sources.
COPY packages/config   packages/config
COPY packages/contracts packages/contracts
COPY apps/fake-gen      apps/fake-gen

# Build the dependency (contracts) then the service.
RUN pnpm --filter @dopamine/contracts build \
 && pnpm --filter @dopamine/fake-gen build

# Produce a self-contained deployment for the runtime image: a flattened
# node_modules with only @dopamine/fake-gen's production deps + its dist/.
RUN pnpm --filter @dopamine/fake-gen deploy --prod --legacy /app

# ---- runtime ---------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    FAKE_GEN_PORT=8090 \
    FAKE_GEN_HOST=0.0.0.0
WORKDIR /app

# Non-root for safety.
USER node
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/package.json ./package.json

EXPOSE 8090

# Healthcheck mirrors the compose healthcheck (doc 02 §8 / doc 04). `node` is
# always present; no need for wget/curl in the image.
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FAKE_GEN_PORT||8090)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
