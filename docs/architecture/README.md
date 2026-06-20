# Dopamine App — Architecture & Planning

Research and architecture docs for the **Dopamine app**: a gamified, delightful
*fake*-shopping simulator. Users browse fake listings, place fake orders, and
track them — with a catalog that **generates itself on demand** (search for
something new → a language model invents the listing + photos) and an
architecture built to **add new verticals** (today retail; tomorrow food with
live courier tracking) as additive plug-ins, not rewrites.

## Start here

**→ [`00-overview.md`](./00-overview.md)** — the big picture, system architecture
diagrams, and the cross-cutting contracts. Read it first.

## The docs

| # | Doc | What it covers |
|---|---|---|
| 00 | [Overview](./00-overview.md) | Big picture, system diagrams, cross-cutting contracts, principles |
| 01 | [Backend & domain architecture](./01-backend-domain-architecture.md) | Domain model, the **Vertical** abstraction, order state machines, REST/OpenAPI, service decomposition, **DB schema**, the search→generate→persist seam |
| 02 | [AI generation pipeline](./02-ai-generation-pipeline.md) | The signature feature: on-demand listing generation (Claude text + image model), structured output, semantic dedup/caching, cost & safety guardrails |
| 03 | [Client architecture](./03-client-architecture.md) | Web + iOS (+ Android), cross-platform decision, server-driven/vertical-driven UI, generation & tracking UX, dopamine polish |
| 04 | [Real-time tracking](./04-realtime-tracking.md) | Pluggable tracking subsystem, simulation engine, SSE/pub-sub transport, live courier geo streaming |
| 05 | [Infrastructure & cost](./05-infrastructure-and-cost.md) | Hosting topology, **managed-vs-self-hosted Postgres** comparison, R2/CDN, 3-scale **cost model** |
| 06 | [Adding a vertical (food)](./06-extensibility-adding-a-vertical.md) | The extensibility proof: the concrete "add food ordering" walkthrough across every layer |
| 07 | [Roadmap & build order](./07-roadmap.md) | Phased plan, milestones, where contributors plug in |

## The core idea in one paragraph

Everything that differs between verticals (retail vs food) is captured behind a
single **Vertical** abstraction resolved at runtime by `verticalId`. A vertical
plugs in three strategies — **generation** (prompt + schema), **fulfillment**
(order state machine), and **tracking** (state cadence + optional live geo) — plus
a client tracking renderer. The platform (catalog, search, cart, orders,
generation pipeline, real-time transport, clients) stays vertical-agnostic and
renders lifecycles **from server data, not hardcoded enums**. Adding food =
config + three strategy classes + one map renderer. No schema migration, no API
version bump. See [`06`](./06-extensibility-adding-a-vertical.md).

## Recommended stack (summary)

NestJS/TypeScript modular monolith · REST + OpenAPI 3.1 · Postgres + `pgvector` +
FTS + JSONB · Cloudflare R2 + CDN (zero egress) · Redis/BullMQ · Claude (text) +
a text-to-image provider · Ably (real-time) · Expo/React Native (iOS+Android) +
React/Next.js web (surgical SwiftUI escape hatches) ·
PaaS (Fly/Render) + Vercel → AWS at scale · managed Postgres (Neon) until you have
ops. Rationale and trade-offs in each doc; consolidated in [`00`](./00-overview.md) §5.

## Status & caveats

These are **planning/research docs**, not implementation. Pricing in
[`05`](./05-infrastructure-and-cost.md) was gathered June 2026 from official
sources for self-hosted/IaC/observability; the **managed-Postgres list prices**
were assembled from product knowledge while live search was unavailable and are
marked _(verify)_ — re-check those before budgeting. Model/image-provider choices
in [`02`](./02-ai-generation-pipeline.md) should be confirmed against the latest
provider docs at build time.
