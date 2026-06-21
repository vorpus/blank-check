# blank-check

The **Dopamine app** — a gamified fake-shopping simulator with an AI-generated
catalog. See [`docs/architecture`](./docs/architecture/) for the design and
[`plan/`](./plan/) for the staged build plan.

**Stage 1 (local skeleton) is built**: the full retail loop — search → grid →
listing → cart → order → live tracking — runs locally as Docker containers with
a fake AI-generation service, no accounts, and a simple web frontend.

## Quick start

Requires Docker + Compose. No real API keys needed.

```bash
make up && make seed   # cold-starts the whole stack in ~20s
```

Then open **http://localhost:3000**. The first run builds images; `make up`
brings up every service and `make seed` loads the starter retail catalog.

```bash
make e2e               # proves the acceptance demo (13 assertions, all 5 criteria)
```

### Common commands

| Command | What it does |
|---|---|
| `make up` | Build (if needed) + start the full stack, wait for healthy |
| `make up-build` | Force a rebuild of all images, then start |
| `make seed` | Load the starter retail catalog |
| `make e2e` | Run the end-to-end acceptance suite against the running stack |
| `make dev` | Start with the hot-reload dev overlay |
| `make logs` / `make ps` | Tail logs / show service status |
| `make down` | Stop the stack |
| `make reset` | Stop and wipe volumes (clean slate) |
| `make help` | List all targets |

### Services

| Service | URL | Role |
|---|---|---|
| web | http://localhost:3000 | Next.js frontend |
| api | http://localhost:8080 | NestJS API + SSE |
| fake-gen | http://localhost:8090 | Fake AI generation (Stage 2 swaps this for real Claude + images) |
| minio | http://localhost:9001 | Object storage console |

postgres (5432) and redis (6379) back the api/worker.
