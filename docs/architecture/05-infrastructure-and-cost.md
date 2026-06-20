# 05 — Infrastructure, Hosting & Cost

> Scope: where everything runs, which datastores to pick and host where, and a
> concrete cost model at three scales. Companion to `01` (domain/data model),
> `02` (AI pipeline — the dominant cost driver), `03` (clients), and
> `04` (real-time tracking — the one workload that hates serverless).

> **Sourcing note.** Self-hosted compute/storage pricing and the
> IaC/CI/secrets/observability tables below were gathered from official
> vendor pricing pages (June 2026) by the research agents and are cited inline.
> The **managed-Postgres list prices** in §3 were assembled from product
> knowledge while live web search was unavailable; treat any figure marked
> _(verify)_ as approximate and re-check against the linked pricing page before
> committing budget. The relative conclusions (managed-vs-self-hosted crossover,
> dominant cost drivers) are robust to the exact numbers.

---

## 0. TL;DR recommendations

| Decision | MVP (start here) | When you outgrow it |
|---|---|---|
| **Overall hosting** | One PaaS (Fly.io or Render) for all backend services + Vercel for the web app | AWS (ECS Fargate / EKS) once you need fine-grained scaling, VPC peering, or committed-use discounts |
| **Primary DB** | **Managed Postgres with scale-to-zero — Neon** (or Supabase if you want auth+storage+realtime bundled) | Aurora PostgreSQL (provisioned, I/O-Optimized) or a self-managed HA pair on dedicated instances |
| **Self-host Postgres?** | **No.** Not worth the ops time at MVP | Reconsider only at sustained large scale (see §3.4 crossover) |
| **Search / vector** | **Postgres + `pgvector`** (one engine, see `01`) | Dedicated Typesense/Qdrant fed by the outbox once recall/latency demands it |
| **Object storage + CDN** | **Cloudflare R2 + Cloudflare CDN** (zero egress fees — decisive for an image-heavy app) | Same; R2 scales fine. Add multi-region buckets if needed |
| **Cache / queue** | **Upstash Redis** (serverless, per-request) or the PaaS's managed Redis | ElastiCache / self-managed Redis when request volume makes per-request billing lose |
| **Real-time gateway** | Managed pub/sub (**Ably**, see `04`) — avoids running stateful socket servers | Self-hosted Redis pub/sub + socket gateway on always-on VMs if Ably bill dominates |
| **Simulation jobs** | BullMQ (Node) / River (Go) on a small always-on worker | Temporal Cloud if workflows get saga-complex |
| **CI / IaC / secrets / obs** | GitHub Actions + OpenTofu + SSM Parameter Store + Grafana Cloud free + Sentry | Paid tiers as volume grows |
| **Dominant cost driver** | **LLM + image generation API spend**, then **image egress** | Same — infra is noise next to per-generation cost |

**The single most important cost fact:** at every scale, your bill is dominated
by **AI generation (Claude + image model)** and **image delivery egress** — not
by compute or database. Optimize those first (caching, dedup, R2 zero-egress);
do not over-invest engineering time shaving $20/mo off a database.

---

## 1. Deployment topology

### MVP shape (low-ops, cheap, fast to ship)

```
                    ┌────────────────────────────────────────┐
   Web (browser) ───►  Vercel (Next.js web app + edge CDN)    │
                    └───────────────┬────────────────────────┘
   iOS / Android ──────────┐        │ HTTPS (REST/OpenAPI)
                           ▼        ▼
                 ┌──────────────────────────────────────────┐
                 │  PaaS (Fly.io or Render) — one project    │
                 │                                           │
                 │  ┌─────────────┐   ┌──────────────────┐   │
                 │  │ API service │   │ Generation worker│   │
                 │  │ (NestJS)    │   │ (BullMQ consumer)│   │
                 │  └─────┬───────┘   └───────┬──────────┘   │
                 │        │ SSE/HTTP          │              │
                 │  ┌─────▼───────┐   ┌───────▼──────────┐   │
                 │  │ Sim worker  │   │ (scales 0..N)    │   │
                 │  │ (tracking)  │   └──────────────────┘   │
                 │  └─────────────┘                          │
                 └───┬─────────┬──────────┬─────────┬────────┘
                     │         │          │         │
            ┌────────▼──┐ ┌────▼─────┐ ┌──▼──────┐ ┌▼──────────────┐
            │ Neon      │ │ Upstash  │ │ Cloudfl.│ │ Ably (managed │
            │ Postgres  │ │ Redis    │ │ R2 + CDN│ │ pub/sub, RT)  │
            │ +pgvector │ │cache/queue│ │ images  │ │               │
            └───────────┘ └──────────┘ └─────────┘ └───────────────┘
                     │
            ┌────────▼─────────────────────────────────────┐
            │ External APIs: Anthropic (Claude) +           │
            │ text-to-image provider (see doc 02)           │
            └───────────────────────────────────────────────┘
```

**Why PaaS first.** A small team plus outside contributors should not be
writing Terraform for VPCs and IAM on day one. Fly.io / Render give you
`git push`-to-deploy, managed TLS, private networking between services, and
horizontal scaling knobs — the modular monolith from `01` deploys as 1–2
services (API + worker) and splits later without a topology rewrite.

- **Fly.io** — runs Docker images close to users, first-class support for
  **long-lived connections** (good for the SSE/WebSocket gateway), cheap
  always-on `shared-cpu-1x` machines (~$2–5/mo each). Best fit if you self-host
  the real-time layer later.
- **Render** — simplest DX, managed Postgres/Redis in the same dashboard, good
  background-worker and cron primitives for the simulation engine.
- **Vercel** — host the **web frontend only** (Next.js). Do **not** put the
  WebSocket/SSE gateway or long-running jobs on Vercel functions — they're
  serverless and time-limited (see §2).

### Growth shape

Move the backend to **AWS ECS Fargate** (containers, no node management) behind
an ALB, keep Postgres managed (Neon → Aurora if needed), R2 for images, and
either keep Ably or stand up a self-hosted socket tier on always-on EC2/Fargate
tasks. Go to **EKS only** when you have multiple teams and genuinely need
Kubernetes — it is an ops tax a small team should defer as long as possible.

---

## 2. Compute hosting & the serverless caveat

| Option | Good for | Watch out |
|---|---|---|
| **PaaS containers** (Fly/Render) | MVP API + workers, lowest ops | Less control, can get pricey vs raw VMs at scale |
| **AWS Fargate** | Growth-stage containers, no servers to patch | ~20–30% premium over raw EC2 for the convenience |
| **AWS EC2 (raw)** | Cheapest sustained compute, full control | You own patching, scaling, AMIs |
| **EKS / Kubernetes** | Many services / teams | Heavy ops tax; defer |
| **Serverless** (Lambda / Cloud Run) | Spiky stateless work, the generation **enqueue** path | ⚠️ **Bad for the real-time gateway** |

> ⚠️ **The real-time gateway must run on always-on compute.** WebSocket/SSE are
> long-lived connections; Lambda caps execution duration and bills for wall-clock
> connection time, which is the wrong model. Run the socket/SSE tier (or the
> simulation worker that pushes events) on **Fly machines / Render workers /
> Fargate tasks / EC2** — not on request-scoped serverless. This is the main
> reason the topology isn't "just put it all on Lambda." (See `04`: the managed
> alternative — **Ably** — sidesteps this entirely by hosting the stateful
> connection layer for you.)

The **generation worker** (BullMQ consumer) and **simulation worker** are also
long-running and benefit from always-on small instances; the bursty
**image-generation fan-out** is the one piece that could scale to serverless if
its provider calls are slow and spiky.

---

## 3. Database hosting — the priority comparison

You want one Postgres that also does full-text search and `pgvector` semantic
dedup (see `01`). The question the user asked: **managed (e.g. RDS/Aurora) vs
running our own Postgres on an instance we own?**

### 3.1 Managed Postgres options _(list prices, us-east-class, approximate)_

| Option | Entry config | ~$/mo | Scale-to-zero | pgvector | Notes |
|---|---|---:|:--:|:--:|---|
| **Neon** | Launch plan | ~$19 _(verify)_ | ✅ yes | ✅ | Serverless Postgres; compute by CU-hr, storage ~$1.50/GB. **Best bursty-MVP fit** |
| **Supabase** | Pro | ~$25 _(verify)_ | paused on free only | ✅ | Bundles **auth + storage + realtime** — can collapse several boxes in our diagram |
| **AWS RDS PostgreSQL** | db.t4g.micro + 20GB gp3 | ~$15–18 _(verify)_ | ❌ | ✅ | db.t4g.medium ≈ ~$50/mo compute; Multi-AZ ~2× |
| **AWS Aurora Serverless v2** | 0.5 ACU min, scales to 0 | ~$0–45 _(verify)_ | ✅ (auto-pause) | ✅ | $/ACU-hr; great for spiky load, pricier per-unit at sustained high load |
| **AWS Aurora (provisioned)** | db.r6g.large, I/O-Optimized | ~$210+ _(verify)_ | ❌ | ✅ | Growth-stage HA workhorse; I/O-Optimized removes per-request I/O billing |
| **Render Postgres** | Starter | ~$7+ _(verify)_ | ❌ | ✅ | Convenient if backend is on Render |
| **Crunchy Bridge / Timescale** | Hobby/entry | ~$10+ _(verify)_ | ❌ | ✅ | Postgres specialists; Timescale if time-series tracking analytics later |

**MVP recommendation: Neon.** Scale-to-zero means an idle MVP costs almost
nothing, `pgvector` is supported (co-locating dedup with relational data per `01`),
and branching databases is a nice DX for contributors/preview environments.
**If** you'd rather not run separate auth + object-storage + realtime services,
**Supabase** is a strong alternative that bundles them — at the cost of some
lock-in and less control over the realtime layer than `04` assumes.

### 3.2 Self-managed Postgres on an instance you own

Verified compute/storage numbers from the research pass (official pages,
June 2026):

| Host | Spec (≈4GB-RAM class) | ~$/mo compute | Storage $/GB-mo |
|---|---|---:|---:|
| **Hetzner CPX22** (shared vCPU) | 2 vCPU / 4 GB / 80 GB NVMe | ~$21 | ~$0.048 (volumes) |
| **Hetzner CCX13** (dedicated) | 2 vCPU / 8 GB / 80 GB NVMe | ~$47 | ~$0.048 |
| **DigitalOcean Droplet** | 2 vCPU / 4 GB / 80 GB SSD | $24 | $0.10 (volumes) |
| **AWS EC2 t4g.medium** | 2 vCPU / 4 GB (burstable) | ~$25 + EBS | $0.08 (gp3) |
| **AWS EC2 m7g.large** | 2 vCPU / 8 GB (sustained) | ~$60 + EBS | $0.08 (gp3) |

> ⚠️ **Hetzner raised cloud prices ~2.2–2.75× effective 15 June 2026.** Older
> 2025 articles quoting CPX22 at €7.99 are outdated; figures above are
> post-increase. (Sources: Hetzner price-adjustment doc; Northflank breakdown.)
> All self-host options give **full `pgvector`** — you control the install.

**The honest "true cost" of self-hosting** is not the ~$21–60 VM. It's:
+ backups (you configure/test them — e.g. `pgBackRest` to R2/S3),
+ **HA/failover** (a real standby = a second instance + replication +
  automated promotion → roughly **2× the VM cost** plus setup),
+ patching, minor/major version upgrades, OS hardening,
+ **on-call / your engineering hours** — the dominant hidden cost.

### 3.3 Managed vs self-hosted — the verdict

| | Self-host (Hetzner/EC2) | Managed (Neon/RDS) |
|---|---|---|
| Raw $/mo at small scale | **Lower** (~$21–60) | Higher (~$15–50, but no scale-to-zero on RDS) |
| Backups / PITR | You build & test | Built-in |
| HA / failover | You build (~2× cost + effort) | Toggle / built-in |
| Patching & upgrades | You own | Automated |
| Scale-to-zero (idle MVP) | ❌ pay 24/7 | ✅ Neon/Aurora Sv2 → near-$0 idle |
| Eng-hours/month | **Several** | ~Zero |
| pgvector | ✅ | ✅ |

**Verdict for this product: use managed Postgres until you have a dedicated
ops/SRE function.** A founder-hour is worth far more than the ~$20–40/mo a
managed DB adds, and the AI/image spend dwarfs both. Self-hosting on
Hetzner/Hetzner-volumes only starts to pay off when (a) the DB is large and
**steadily** busy (so scale-to-zero gives you nothing), and (b) you have someone
whose job is to own backups, HA, and upgrades.

### 3.4 Where the answer flips

- **Stick with managed** while the DB is small/bursty or the team is ≤ a few
  engineers with no ops specialist. Neon's scale-to-zero makes managed *cheaper*
  than a 24/7 self-hosted VM for a low-traffic MVP.
- **Self-host becomes attractive** when you're running a **steadily-loaded**
  instance ≳ 8–16 GB RAM 24/7 (where managed premiums and especially Aurora
  per-ACU/IO billing pile up), **and** you have someone to own HA + backups +
  on-call. At that point a Hetzner dedicated-vCPU pair (primary + standby) can
  undercut equivalent RDS/Aurora by a wide margin on raw cost — but only if you
  genuinely absorb the ops.
- A common middle path: managed Postgres + a **read replica** for analytics,
  never touching self-host.

---

## 4. Search & vector hosting

Per `01`, **start with Postgres + `pgvector`** — one engine does OLTP + JSONB +
full-text (`tsvector`) + ANN vector search, and a single SQL query joins vector
similarity with relational filters (critical for "dedup *and* in-stock retail
listings"). No extra service, no sync code, available on every managed option
above.

**Graduate to a dedicated engine** only when pgvector recall/latency or full-text
relevance becomes a bottleneck, fed asynchronously from the transactional outbox:

| Engine | Host | Cost shape | When |
|---|---|---|---|
| **Typesense / Meilisearch** | Self-host (Fly/VM) or Typesense Cloud | Cheap self-host; small managed tiers | Best-in-class typo-tolerant catalog search |
| **Qdrant / Weaviate** | Self-host or managed | Per-node / managed tiers | Large vector corpus, hybrid search |
| **OpenSearch / Elastic** | AWS managed / Elastic Cloud | Pricey, ops-heavy | Heavy log+search at scale |
| **Pinecone / Algolia** | Fully managed | Usage-based, can get pricey | Want zero-ops, will pay for it |

Recommendation: **pgvector now; Typesense (catalog search) + Qdrant (vectors) as
the first split** if needed, never both before they're needed.

---

## 5. Object storage & CDN for generated images

This is image-heavy: every generated listing has a hero + alternate-angle images
served to web and mobile. **Egress is the cost driver**, and it's where vendor
choice matters most.

| Store | Storage $/GB-mo | **Egress** | Notes |
|---|---:|---|---|
| **Cloudflare R2** | ~$0.015 | **$0 (zero egress)** | ✅ **Recommended.** S3-compatible API; pairs with Cloudflare CDN |
| AWS S3 | ~$0.023 | **~$0.09/GB** (then CloudFront on top) | Egress + CDN fees stack up fast for images |
| Backblaze B2 | ~$0.006 | Free via Bandwidth Alliance/CDN partners | Cheapest storage; pair with a partner CDN |

**Recommendation: Cloudflare R2 + Cloudflare CDN.** For an app whose traffic is
mostly "download lots of images," **R2's zero egress** is decisive — it can be
the difference between a trivial and a painful bill at 100k MAU. The generation
worker (`02`) writes images to R2; clients fetch via the Cloudflare CDN with long
cache TTLs and content-hashed URLs (generated images are immutable).

---

## 6. Cache, queue & background/simulation jobs

- **Redis** (cache + BullMQ queue + optional SSE fan-out per `04`):
  - **Upstash** (serverless, per-request billing) — best for MVP/bursty; near-$0
    when idle.
  - **ElastiCache / self-managed Redis** — cheaper at sustained high request
    volume where per-request billing loses.
- **Simulation / scheduled jobs** (`04`): run BullMQ delayed jobs (Node) or
  River (Go) on a **small always-on worker** (Fly machine / Render worker /
  Fargate task). The DB row + persisted job are the source of truth, so jobs
  survive deploys. **Temporal Cloud** is the escape hatch if tracking workflows
  become saga-complex — but it's overkill for the MVP.

---

## 7. CI/CD, IaC, secrets, observability

Verified pricing from the research pass (official pages, June 2026). A complete
MVP stack here runs at **$0/mo** inside free tiers.

| Layer | MVP pick (free) | What you get | Paid next step |
|---|---|---|---|
| **CI/CD** | **GitHub Actions** | Unlimited on public repos; 2,000 min/mo private (Free) | Team $4/user; self-hosted runners stay free |
| **IaC** | **OpenTofu** (MPL-2.0 Terraform fork) | Fully free, unlimited | HCP Terraform / Pulumi Cloud / SST Console if you want hosted state + drift |
| **Secrets** | **AWS SSM Parameter Store** | 10,000 standard params free forever | Secrets Manager $0.40/secret if you need rotation; Doppler/Infisical for nicer UX |
| **Metrics/Logs/Traces** | **Grafana Cloud free** | 10k series + 50 GB logs + 50 GB traces, 14-day retention, 3 users | Grafana Pro; **avoid Datadog early** — host + product stacking makes bills 2–3× naive estimates |
| **Errors** | **Sentry Developer** | 5,000 errors/mo | Team $26/mo |

> Notable 2026 context the agents flagged: GitHub Actions rates dropped up to
> ~39% effective Jan 1 2026 and the proposed self-hosted-runner charge was
> postponed indefinitely; Terraform is BSL (source-available) since 2023 — prefer
> **OpenTofu** for a contributor-friendly OSS license; HCP Terraform's legacy
> free plan EOL'd Mar 31 2026.

**IaC guidance:** keep MVP infra mostly click-ops/PaaS-config, but commit an
**OpenTofu** module for the AWS pieces you do create (R2 bucket/CDN, IAM,
parameter store) so environments (dev/staging/prod) are reproducible and
contributors can stand up their own.

---

## 8. Cost model at three scales

> Rough monthly USD, list prices. **Read the bottom rows first** — AI generation
> and image egress dominate; infra is a rounding error by comparison. Generation
> volume assumes aggressive caching/dedup (`02`): most searches hit existing
> listings; only *novel* items generate.

| Component | (a) MVP ~hundreds users | (b) ~10k MAU | (c) ~100k MAU |
|---|---:|---:|---:|
| Web hosting (Vercel) | $0–20 | $20–50 | $150–400 |
| Backend compute (API+workers) | $10–30 (Fly/Render) | $80–200 | $600–1,500 (Fargate) |
| Real-time gateway (Ably) | $0–25 (free/entry) | $100–400 | $800–2,500 (or self-host to cut) |
| **Postgres (managed)** | **$0–25** (Neon scale-to-zero) | $70–200 | $400–1,200 (Aurora/replica) |
| Redis (Upstash) | $0–10 | $30–80 | $150–400 |
| Search/vector | $0 (pgvector) | $0–100 | $200–800 (if split out) |
| **Object storage + CDN egress (R2)** | **$1–15** | **$50–300** | **$500–3,000** |
| Observability/CI/secrets | $0 (free tiers) | $50–200 | $300–1,000 |
| **🔴 LLM (Claude) generation** | **$50–300** | **$1k–6k** | **$8k–40k+** |
| **🔴 Image generation API** | **$50–400** | **$1k–8k** | **$10k–60k+** |
| **Rough total** | **~$150–800** | **~$3k–15k** | **~$25k–110k** |

**Dominant cost driver at every stage: AI generation (Claude text + image
model).** See `02` for the levers that move these red rows by an order of
magnitude: semantic dedup so "ladder"/"a ladder"/"ladders" generate **once**,
pre-seeding popular categories, prompt caching, cheaper-model fast paths, and
async/batched image generation. **Image egress** (the other big mover) is why R2
zero-egress is a top-level decision, not a footnote.

**Practical implication:** spend engineering effort on the generation/dedup/cache
pipeline and on R2; do **not** spend it micro-optimizing the database host. A
self-hosted Postgres saving $30/mo is invisible next to a $40k LLM bill — but a
10% improvement in cache hit rate is worth thousands.

---

## 9. "Start here" → "outgrow it" migration path

1. **MVP:** Vercel (web) + Fly/Render (API + workers) + **Neon** Postgres +
   Upstash Redis + **R2/CDN** + **Ably** + GitHub Actions/OpenTofu/Grafana free.
   Everything scale-to-zero or free-tier; idle cost near $0 outside AI spend.
2. **Traction (~10k MAU):** bump instance sizes; add a Postgres read replica;
   keep Ably; turn on paid observability tiers. Re-evaluate generation spend with
   real cache-hit data (this is where the budget actually lives).
3. **Scale (~100k MAU):** move backend to **Fargate**; Postgres → Aurora
   (provisioned, I/O-Optimized) or a managed HA setup; consider self-hosting the
   real-time tier (Redis pub/sub + socket gateway on always-on compute) if the
   Ably bill dominates; split search to Typesense/Qdrant if pgvector strains.
   **Only now** evaluate self-hosted Postgres on Hetzner/EC2 — and only if you've
   hired someone to own it.

---

## Appendix — sources (gathered June 2026)

Self-hosted compute/storage: Hetzner price-adjustment doc & product pages;
DigitalOcean droplet/volume/managed-DB pricing; AWS EC2 on-demand & EBS pricing
(via vendor pages and Vantage instance tables).
CI/IaC/secrets/observability: github.com/pricing & Actions billing docs;
gitlab.com/pricing; circleci.com/pricing; hashicorp.com & opentofu.org;
pulumi.com/pricing; sst.dev; aws.amazon.com secrets-manager & systems-manager
pricing; doppler.com; infisical.com; datadoghq.com; grafana.com/pricing;
axiom.co; sentry.io/pricing.
Managed Postgres list prices (§3.1): assembled from product knowledge while live
search was unavailable — **re-verify** against neon.tech/pricing,
supabase.com/pricing, aws.amazon.com/rds/aurora/pricing before budgeting.
