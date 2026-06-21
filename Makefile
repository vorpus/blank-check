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
	pnpm --filter "@dopamine/sdk" generate
	@echo "SDK regenerated from /v1 OpenAPI spec"

## psql: open a psql shell in the postgres container
psql:
	$(COMPOSE) exec postgres psql -U app -d dopamine

## mc: run an mc command against minio, e.g. make mc ARGS="ls local/listing-images"
mc:
	$(COMPOSE) run --rm --entrypoint sh minio-init -c \
	  'mc alias set local http://minio:9000 "$$MINIO_ROOT_USER" "$$MINIO_ROOT_PASSWORD" >/dev/null && mc $(ARGS)'
