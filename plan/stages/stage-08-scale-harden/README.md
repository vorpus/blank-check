# Stage 08 — Scale & Harden

> **Status:** Planned / ongoing once real traffic exists. **Depends on:** Stage 05
> (cloud) and real usage data.
> **Goal:** take the cloud-deployed app from "works" to "works at scale,
> efficiently, observably, and safely" — driven by **real** metrics, not guesses.

Realizes architecture doc **05 §9** (scale path) and roadmap **Phase 5**.

## Principle

Optimize against measured reality. The architecture is explicit that **cost lives
in AI + image egress, not infra** — so the biggest lever here is re-tuning
generation spend with real cache-hit data, not micro-optimizing compute.

## Scope (apply as metrics demand, not preemptively)

- **Database:** read replica → Fargate/Aurora as load grows; index tuning from
  real query plans; connection pooling.
- **Search:** if pgvector/FTS strains at catalog size, introduce **Typesense or
  Qdrant** as an event-fed read index (additive — indexing is already
  event-driven via the outbox). Don't do this preemptively.
- **Workers:** autoscale the generation/enrichment + fulfillment worker pools;
  tune BullMQ concurrency; DLQ triage runbook.
- **Realtime:** evaluate self-hosting the realtime tier if Ably cost dominates;
  scale SSE/pub-sub fan-out horizontally.
- **Generation economics:** re-tune `reuse_threshold`/`review_band`, seeding
  breadth, grid/batch sizes, and the Opus→Haiku / final→placeholder degrade
  thresholds against logged cache-hit and cost data. This is where the budget
  actually lives.
- **Observability/SLOs:** define and alert on SLOs (search latency, generation
  success/latency, tracking event delivery, order-transition latency); load
  testing; chaos/reconnect testing.
- **Security & abuse hardening:** full security review, secret rotation, abuse
  pattern detection on the cold-generation path, WAF/rate-limit tuning.

## Exit criteria

This stage has no single "done" — it's the steady-state operational discipline.
Milestone checkpoints: defined SLOs with alerting; a documented cost-per-active-
user trend that's flat or falling as traffic grows; load tests pass target
concurrency; a completed security review with findings resolved.
