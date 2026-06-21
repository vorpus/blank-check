# Build Plan — Dopamine App

This folder is the **execution layer** for building the Dopamine app. The
[`docs/architecture`](../docs/architecture/) folder is the *what & why* (the
target architecture, the contracts, the trade-offs). This `plan/` folder is the
*how & when* — it sequences that architecture into shippable **stages**, each
with its own engineering implementation docs.

> **Architecture is the destination; the plan is the route.** Every stage cites
> the architecture docs it realizes. Read [`docs/architecture/00-overview.md`](../docs/architecture/00-overview.md)
> first — especially §4, the cross-cutting contracts. Those contracts are frozen
> early on purpose, so the stages and the parallel tracks inside them don't block
> each other.

---

## Guiding philosophy

1. **Local-first, then real, then cloud.** We build the entire product loop on a
   laptop with Docker and *fake* services first. We only swap in real AI,
   managed databases, and cloud hosting once the shape of the product is proven
   and stable. This keeps early iteration free, fast, and offline-able.
2. **Every fake is a seam, not a shortcut.** Stage 1's fake AI-generation
   service implements the *exact same contract* (`GenerationProvider`,
   `media.status`, the event shapes) that the real pipeline will. Swapping fake
   → real in a later stage is a dependency change behind an interface, never a
   rewrite. Same rule for storage (MinIO → R2), realtime (in-process SSE → Ably),
   and DB host (local Postgres → Neon).
3. **Render from data.** Clients render lifecycles, stages, and tracking mode
   from server-provided data from day one — so adding verticals or platforms
   later is additive (architecture principle #2).
4. **Stages are vertical slices.** Each stage delivers a usable, demoable
   product increment — not a horizontal layer. Stage 1 is the whole loop, thinly.
5. **Order by necessity, but stay reorderable.** The sequence below is priority
   order. Where two stages are independent, the dependency table says so and they
   can run in parallel or swap.

---

## The stages

| # | Stage | Theme | Outcome | Architecture refs |
|---|---|---|---|---|
| **01** | [Local skeleton](stages/stage-01-local-skeleton/) | **Foundations / local** | The full retail loop — search → grid → listing → cart → order → live timeline — running as Dockerized containers on a laptop, with **fake** AI generation (placeholder listings + images), **no accounts**, and a **simple web frontend** that defines the feature set and core working data model. | 00, 01, 03, 04, 07 (P0–P1) |
| **02** | [Real AI generation](stages/stage-02-real-ai-generation/) | **Wire up real services (AI)** | Swap the fake generation service for the real pipeline: Claude structured output, real image generation, pgvector semantic dedup, canonicalization, generation locks, async image enrichment, streaming UX, cost/abuse controls, moderation, eval harness. Still local Docker. | 02, 01 §4, 07 (P2) |
| **03** | [Frontend & dopamine polish](stages/stage-03-frontend-dopamine/) | **Improve the frontend** | Make it *feel* great: animation system, haptics/sound intents, micro-interactions, the celebratory order moment, streaming token render + blurhash + cross-fade, design-system maturity, a11y, perceived-performance. | 03 §6, 07 (P3) |
| **04** | [Accounts & auth](stages/stage-04-accounts-auth/) | **Identity** | Upgrade anonymous/device identity to real accounts: JWT access + refresh, OAuth providers, account upgrade flow (carts/orders migrate from anon → account), per-user history, identity-scoped rate limits. | 01 §3.2, 01 §8.3 |
| **05** | [Cloud migration & managed services](stages/stage-05-cloud-migration/) | **Migrate to cloud** | Lift from local Docker to managed/cloud: Neon/Supabase Postgres, Cloudflare R2 + CDN, Ably (or self-host) realtime, PaaS hosting (Fly/Render) + Vercel web, OpenTofu IaC, GitHub Actions CD, Sentry + Grafana observability. Realtime hardening (snapshot+replay, seq, reconnect at scale). | 05, 04, 07 (P5) |
| **06** | [Mobile app](stages/stage-06-mobile-app/) | **New platform** | Expo / React Native iOS app (then Android) consuming the same OpenAPI SDK + realtime contract. Native loop, surgical SwiftUI escape hatches on hero screens. "Another client of the same contracts," not a new architecture. | 03 §1, 07 (Android) |
| **07** | [Food vertical](stages/stage-07-food-vertical/) | **Prove extensibility** | Add food ordering as **additive strategies** + live courier-on-a-map tracking (OSRM, geo channel). The architecture's own acceptance test: no DB migration, no API version bump, no core edits. | 06, 04 §4, 07 (P4) |
| **08** | [Scale & harden](stages/stage-08-scale-harden/) | **Scale** | Read replicas → Aurora, dedicated search (Typesense/Qdrant) if pgvector strains, autoscale workers, tighten observability/SLOs, re-tune generation spend with real cache-hit data, security review. | 05 §9, 07 (P5) |

### Dependency / ordering notes

- **01 is the hard prerequisite for everything.** It freezes the contracts.
- **02 depends only on 01** (it fills the generation seam 01 stubs). It is the
  highest-value follow-on — it's the product's magic — so it's sequenced second.
- **03 (frontend polish)** can begin any time after 01 and overlaps 02 heavily;
  it only needs screens to exist. Listed third by priority, not by dependency.
- **04 (accounts)** depends on 01. Independent of 02/03 — can slot earlier if a
  shareable/multi-user demo is needed sooner.
- **05 (cloud)** depends on 01 (and ideally 02, so you're not paying to host
  fakes). Pull it earlier only when you need a publicly reachable deployment.
- **06 (mobile)** depends on 01's contracts + SDK; best after 02 so it inherits
  the real generation UX, but RN sharing makes it cheap alongside 03.
- **07 (food)** depends on the platform seams from 01–02 being solid. It's a
  *validation* milestone, deliberately later.
- **08** is ongoing once real traffic exists (needs 05).

```
        ┌──────────────────────────── 01 Local skeleton (contracts frozen) ────────────────────────────┐
        │                                                                                                │
        ▼                 ▼                          ▼                         ▼               ▼          ▼
   02 Real AI        03 FE polish              04 Accounts              05 Cloud         06 Mobile   07 Food
        │              (overlaps 02)                 │                       │               │          │
        └──────────────────────────────────────────────────────────────────┴──────────────► 08 Scale & harden
```

---

## How to use this folder

- **Building Stage N?** Open `stages/stage-0N-*/README.md` (the **charter**:
  goal, scope, the services it touches, exit criteria) and then its numbered
  implementation docs (`01-*.md`, `02-*.md`, …) authored per workstream.
- **Stage 1 is fully specified** (it's the current build target). Stages 2–8
  have a charter that fixes goal/scope/exit-criteria/dependencies; their deep
  implementation docs are written when that stage becomes the active target, so
  they're informed by what Stage 1 actually taught us.
- Each implementation doc ends with an **exit checklist** — the stage is "done"
  when every workstream's checklist passes and the stage-level **acceptance
  demo** runs green.

---

## Status

| Stage | Charter | Impl docs | Status |
|---|---|---|---|
| 01 | ✅ | ✅ (team-authored) | **✅ BUILT — `docker compose` cold-start + acceptance demo (`make e2e`, 13 assertions) pass; 136 tests** |
| 02–08 | ✅ | ⏳ written when active | planned |

### Stage 01 — built artifacts

A pnpm/Turborepo monorepo implementing the full local skeleton. `make up && make
seed` cold-starts the whole stack (~20s) and `make e2e` proves the charter §6
acceptance demo.

```
packages/  contracts (Zod wire contracts) · sdk (typed ApiClient + TrackingClient) · config
apps/      api (NestJS+Prisma) · worker (BullMQ) · fake-gen (Fastify stub provider) · web (Next.js)
infra      docker-compose (+dev override) · Makefile · Dockerfiles · .env.example (zero real keys)
```

Built milestone-by-milestone (M1 foundation → M2 infra+fake-gen → M3a/b api+worker
→ M4a/b sdk+web → M5 integration), each verified and committed, with two
production-review→fix loops folded in (`git log` for the trail).
