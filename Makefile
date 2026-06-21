# Dopamine -- Stage 1 task DX.
#
# One-command cold start (once app code exists in later milestones):
#   make up && make seed   ->  working app at http://localhost:3000
#
# `make up` autocreates .env, builds images, and blocks on --wait until every
# healthcheck is green; migrate + seed run as ordered one-shots in the bring-up.
#
# NOTE (Stage 1, this milestone): the api/web/worker/fake-gen IMAGES cannot be
# built until their app source lands (later milestones). Until then, bring up
# only the datastores with:  make datastores
COMPOSE := docker compose
SHELL   := /bin/bash

.DEFAULT_GOAL := help
.PHONY: help up up-build datastores down reset seed migrate logs ps sdk psql mc build

## help: list available targets (default)
help:
	@echo "Dopamine -- Stage 1 infra targets:"
	@echo ""
	@grep -E '^## [a-z-]+:' $(MAKEFILE_LIST) | sed 's/^## //' | awk -F': ' '{ printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2 }'
	@echo ""
	@echo "  cold start (full):  make up && make seed"
	@echo "  this milestone:     make datastores   (api/web images need app source)"

## up: .env + build images + bring whole stack up, wait for healthy
up: .env
	$(COMPOSE) up -d --build --wait
	@echo "stack up -> web http://localhost:3000 . api http://localhost:8080 . minio http://localhost:9001"

## up-build: rebuild all images, then up --wait (no cache reuse forced)
up-build: .env
	$(COMPOSE) build
	$(COMPOSE) up -d --wait

## datastores: bring up only postgres+redis+minio+minio-init (runnable now)
datastores: .env
	$(COMPOSE) up -d --wait postgres redis minio
	$(COMPOSE) up minio-init
	@echo "datastores up -> postgres :5432 . redis :6379 . minio :9000 (console :9001)"

# Create local .env from the committed example on first run.
.env:
	cp .env.example .env
	@echo "created .env from .env.example (zero real keys needed)"

## down: stop containers, keep volumes (fast restart)
down:
	$(COMPOSE) down

## reset: wipe everything including named volumes -- pristine cold start
reset:
	$(COMPOSE) down -v --remove-orphans
	@echo "volumes wiped (pgdata, redisdata, miniodata)"

## seed: re-run the idempotent seed one-shot against the running stack
seed:
	$(COMPOSE) run --rm seed

## migrate: apply Prisma migrations without a full restart
migrate:
	$(COMPOSE) run --rm migrate

## logs: tail all service logs
logs:
	$(COMPOSE) logs -f --tail=200

## ps: show service status / health at a glance
ps:
	$(COMPOSE) ps

## build: build all images (no up)
build:
	$(COMPOSE) build

## sdk: regenerate the typed SDK from the /v1 OpenAPI spec (doc 05 3.2)
sdk:
	# 1. dump the spec from the NestJS app (pure schema build — no DB needed),
	#    committing the reviewable artifact into the SDK package. The path is
	#    absolute because `pnpm --filter` runs the script with the api dir as CWD.
	pnpm --filter "@dopamine/api" run openapi:dump "$(CURDIR)/packages/sdk/openapi/v1.json"
	# 2. generate transport types from the committed spec (paths are package-relative
	#    inside the SDK's own `openapi:gen` script: ./openapi/v1.json → ./src/openapi.gen.ts).
	pnpm --filter "@dopamine/sdk" run openapi:gen
	# 3. typecheck the SDK against the freshly generated types.
	pnpm --filter "@dopamine/sdk" run typecheck
	@echo "SDK regenerated from /v1 OpenAPI spec"

## sdk-check: drift gate — regenerate into a temp dir, fail if anything differs
sdk-check:
	@tmp=$$(mktemp -d); \
	pnpm --filter "@dopamine/api" run openapi:dump "$$tmp/v1.json" >/dev/null 2>&1; \
	pnpm --filter "@dopamine/sdk" exec openapi-typescript "$$tmp/v1.json" -o "$$tmp/openapi.gen.ts" >/dev/null 2>&1; \
	ok=1; \
	diff -u packages/sdk/openapi/v1.json "$$tmp/v1.json" || ok=0; \
	diff -u packages/sdk/src/openapi.gen.ts "$$tmp/openapi.gen.ts" || ok=0; \
	rm -rf "$$tmp"; \
	if [ $$ok -eq 1 ]; then echo "SDK drift gate: clean (spec + generated types up to date)"; \
	else echo "ERROR: SDK is out of date — run 'make sdk' and commit the result."; exit 1; fi

## psql: open a psql shell in the postgres container
psql:
	$(COMPOSE) exec postgres psql -U app -d dopamine

## mc: run an mc command against minio, e.g. make mc ARGS="ls local/listing-images"
mc:
	$(COMPOSE) run --rm --entrypoint sh minio-init -c \
	  'mc alias set local http://minio:9000 "$$MINIO_ROOT_USER" "$$MINIO_ROOT_PASSWORD" >/dev/null && mc $(ARGS)'
