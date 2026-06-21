# Stage 05 — Cloud Migration & Managed Services

> **Status:** Planned. **Depends on:** Stage 01 (ideally also 02, so you're not
> paying to host fakes). Pull earlier only when a publicly reachable deployment
> is needed.
> **Goal:** lift the local Docker stack to managed/cloud services and a real
> deployment — each swap is behind an interface Stage 1 already drew, so this is
> migration, not rewrite. Also harden realtime for real concurrency.

Realizes architecture doc **05** (infra & cost), **04** (realtime), roadmap P5.

## The swaps (each is a one-container/one-adapter change)

| Local (Stage 1) | Managed (this stage) | Behind |
|---|---|---|
| Postgres container | **Neon** (or Supabase) Postgres + pgvector | Prisma datasource URL |
| MinIO | **Cloudflare R2 + CDN** (zero egress) | S3 client config |
| Redis container | **Upstash** Redis | Redis URL |
| In-process / Redis SSE fan-out | **Ably** (managed realtime) — or keep self-host | realtime transport adapter |
| docker-compose | **Fly / Render** (api + worker) + **Vercel** (web) | deploy targets |
| local `.env` | secrets manager / platform secrets | secret strategy |

## Scope

- **Provision** Neon, R2, Upstash, Ably, hosting projects.
- **IaC:** OpenTofu modules for the Cloudflare/AWS/PaaS pieces; reproducible
  environments (dev/staging/prod).
- **CI/CD:** GitHub Actions — build images, run migrations, deploy api/worker/web,
  regenerate the SDK from OpenAPI.
- **Realtime hardening:** Ably (or self-hosted Redis pub/sub across instances),
  snapshot+replay at scale, `seq` gap-free ordering under reconnect storms,
  connection limits, SSE→polling degradation under load.
- **Observability:** Sentry (errors), Grafana Cloud / OpenTelemetry traces across
  the generation seam (search-miss → enqueue → worker → write), the metrics that
  matter (generation rate/success/latency/cost, dedup hit-rate, cache hit-rate,
  SSE connection count, transition latency, queue depth), DLQ alerting.
- **Cost model** instrumentation (arch 05 §cost) — image egress + AI spend are
  the dominant lines.
- **Data migration** path from local seed/dev data where relevant.

## Exit criteria

The app runs on managed services with no local containers; a push to main
deploys api/worker/web via CI; realtime survives reconnect storms with no event
gaps; dashboards show the cost/cache/latency metrics; secrets are managed, not in
`.env`; teardown/rebuild of an environment is reproducible from IaC.
