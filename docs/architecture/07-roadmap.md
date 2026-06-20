# 07 — Roadmap & Build Order

> A phased plan to get from an empty repo to a polished, extensible Dopamine app —
> sequenced so a small core team plus outside contributors can work in parallel
> with minimal blocking. Each phase lists the goal, the workstreams, and where a
> new contributor can plug in.

Read `00` for the architecture and the **cross-cutting contracts** — those
contracts are what let these workstreams proceed independently. Agree on them
early; they're the interfaces between the parallel tracks.

---

## Phase 0 — Foundations (week 0–1)

**Goal:** repo scaffolding + the contracts that unblock everyone.

- Monorepo skeleton (backend, web, mobile, shared packages) — _doc 03 §7_.
- **Pin the cross-cutting contracts** (`00` §4): OpenAPI skeleton, the
  vertical-agnostic order/listing payload shape, generation states
  (`pending→partial→ready→failed`), and the real-time event schema
  (`state_change`/`geo_position` with `seq`). These can be stubbed/mocked so
  clients and backend build against them before the real implementations exist.
- Infra baseline (_doc 05_): Neon Postgres, R2 bucket, GitHub Actions CI,
  OpenTofu module for the AWS/Cloudflare pieces, Sentry + Grafana Cloud free.
- Vertical registry + `retail` config stub (_doc 01/06_).

**Contributors can start:** CI setup, OpenAPI tooling/codegen, design tokens.

---

## Phase 1 — Walking skeleton: browse → cart → order → track (retail) (week 1–4)

**Goal:** the full retail loop end-to-end with **seeded** (not yet generated)
listings, so every layer is exercised before adding AI.

| Workstream | Deliverable | Doc |
|---|---|---|
| Backend | catalog/search (FTS), cart, orders, OpenAPI `/v1`, retail `FulfillmentStrategy` | 01 |
| Real-time | simulation engine (BullMQ delayed jobs), retail `TrackingProvider` (timeline, no geo), Ably transport, snapshot+replay | 04 |
| Web | search → results → listing → cart → checkout → **shipping timeline** tracking | 03 |
| iOS | same loop, native; validate the vertical-agnostic rendering contract on a second platform early | 03 |
| Shared | typed API SDK codegen from OpenAPI; design tokens | 03 |

**Milestone:** place a fake retail order against seeded data and watch the
timeline advance in real time on both web and iOS.

**Contributors can start:** individual screens, the timeline component, seed-data
authoring, SDK codegen.

---

## Phase 2 — The signature feature: on-demand generation (week 4–7)

**Goal:** search misses generate real listings. This is the product's magic;
build it behind the seam defined in Phase 0 so it drops into the working loop.

| Workstream | Deliverable | Doc |
|---|---|---|
| Generation | search-miss → canonicalize → **semantic dedup (pgvector)** → enqueue → Claude structured listing → persist; `GenerationProvider` impl | 02 |
| Images | text-to-image provider integration, hero+alt images → R2/CDN, async delivery | 02 |
| Backend | placeholder-listing write path, Redis dedup lock, idempotency, **rate limits + global generation budget/circuit-breaker** | 01/02 |
| Clients | generation UX: skeletons, `pending→partial→ready` states, progressive image load | 03 |
| Safety | query + content moderation, regeneration, eval harness for listing quality | 02 |

**Milestone:** search "a ladder" (never searched before) → skeleton appears
instantly → a real listing with photos materializes seconds later → next search
for "ladder" is an instant cache/dedup hit.

> ⚠️ This phase introduces the **dominant cost driver** (LLM + image spend,
> _doc 05_). Land caching/dedup, prompt caching, and pre-seeding of popular
> categories *in this phase*, not later — they're not optimizations, they're
> load-bearing for the unit economics.

**Contributors can start:** prompt/schema design, the eval harness, moderation
rules, the skeleton/progressive-image UI.

---

## Phase 3 — Dopamine polish (week 7–10, overlaps Phase 2)

**Goal:** make it *feel* great — the whole point of the product. _doc 03 §6_.

- Animation strategy per platform (Reanimated / Framer Motion / SwiftUI),
  satisfying order-placement moment, celebratory tracking transitions.
- Haptics + sound, micro-interactions, accessibility.
- Perceived-performance tricks around generation (optimistic UI, shimmer).

**Contributors can start:** this is highly parallelizable — individual
animations, sound design, haptic tuning, a11y audits.

---

## Phase 4 — Prove extensibility: the Food vertical (week 10–13)

**Goal:** validate the architecture by adding food ordering as **additive
strategies** — and ship live courier tracking. Follow **doc 06** step by step.

| Step | Deliverable | Doc |
|---|---|---|
| Register `food` vertical | config + strategy wiring | 06 §1 |
| `FoodGenerationStrategy` | menu-item prompt + schema | 06 §2 |
| `FoodFulfillmentStrategy` | fast state machine + timings | 06 §3 |
| `FoodTrackingProvider` | geo enabled + OSRM `geoPlan()` | 06 §4 |
| Geo infra | self-hosted OSRM route service, 1–2s geo channel | 04 §4 |
| Client `LiveCourierMap` | map renderer + courier interpolation | 03/06 §5 |

**Milestone:** order food → watch the lifecycle advance in minutes → see a
courier move smoothly on a live map. **No DB migration, no API version bump, no
core edits** — that's the architecture passing its own test (_doc 06 §7_).

---

## Phase 5 — Scale & harden (ongoing)

Per _doc 05 §9_: read replica → Fargate → Aurora; evaluate self-hosting the
real-time tier if Ably dominates; split search to Typesense/Qdrant if pgvector
strains; tighten observability. Re-tune generation spend with **real cache-hit
data** — this is where the budget actually lives.

---

## Android (when ready)

Slots in after the cross-platform decision in _doc 03 §1_. Because clients render
from data and consume the same OpenAPI SDK + real-time contract, Android is
"another client of the same contracts," not a new architecture. Sequence it after
Phase 2 so it inherits the generation UX, or earlier if RN/Flutter sharing makes
it nearly free alongside iOS.

---

## Parallelism summary — who can start where, day one

| Track | Can start in | Depends on |
|---|---|---|
| OpenAPI/contracts, CI, infra, design tokens | Phase 0 | nothing |
| Backend catalog/cart/orders | Phase 1 | contracts |
| Real-time simulation + transport | Phase 1 | order model + event contract |
| Web & iOS loop | Phase 1 | OpenAPI stub (mockable) |
| Generation pipeline | Phase 2 | search-miss seam + dedup store |
| Polish/animation/sound/a11y | Phase 3 (anytime) | screens exist |
| Food vertical | Phase 4 | platform seams from 1–3 |

The contracts in `00` §4 are deliberately frozen early precisely so these tracks
don't block each other — that's the same decision that makes verticals cheap to
add later.
