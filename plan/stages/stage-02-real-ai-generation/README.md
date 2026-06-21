# Stage 02 — Real AI Generation Pipeline

> **Status:** Planned. **Depends on:** Stage 01 (fills the generation seam it stubbed).
> **Goal:** replace the `fake-gen` container with the real generation pipeline so
> search misses produce genuinely AI-generated listings — the product's magic —
> **without touching `api`, the contracts, or the clients.** Still local Docker.

Realizes architecture doc **02** (AI generation pipeline) and **01 §4** (the seam).

## Why this is Stage 2

It's the highest-value follow-on to the skeleton: the entire point of the product
is the self-generating catalog. Stage 1 proved the loop and froze the
`GenerationProvider` contract; Stage 2 makes the content real behind that exact
interface.

## Scope

- **Text generation:** Claude structured output (`claude-opus-4-8` default,
  `claude-haiku-4-5` fast/fallback) via `output_config.format` json_schema, the
  retail listing schema (arch 02 §2.2), prompt caching on the stable system
  prompt. *Grounded in the `claude-api` skill, not memory.*
- **Streaming COLD path:** stream tokens field-by-field on first generation
  (arch 02 §1.4) — the `generating_text` state the Stage 1 client already knows.
- **Images:** real text-to-image provider (gpt-image-1.5 primary, Flux Schnell
  placeholder), async enrichment via webhook, transcode→webp + blurhash + EXIF
  strip, into MinIO (still local; R2 is Stage 05).
- **Embeddings + semantic dedup:** add **pgvector** (HNSW) to Postgres,
  `text-embedding-3-large`@1024d behind an `Embedder` interface, the
  normalize→exact-hash→semantic-NN→reuse-or-generate pipeline (arch 02 §4),
  reuse/review thresholds.
- **Multi-listing grid generation** (arch 02 §4.7) — one call → N distinct
  variants; the blended hot/warm/cold regime replacing Stage 1's simplified stub.
- **Cost & abuse controls:** prompt caching, Opus→Haiku degrade, per-user +
  global generation budgets, the generation lock (already in Stage 1), batch
  pre-seeding of popular categories via the Batches API.
- **Safety:** input/output/image moderation gates, refusal handling
  (`stop_reason`), quarantine queue, regenerate endpoint.
- **Eval harness:** golden set + LLM-as-judge rubric, dedup precision/recall,
  image QA — gates prompt/model changes.

## Dependencies / swaps

Swap the `fake-gen` container for `generation` service; add `pgvector` to the
Postgres image; add Anthropic + image-provider API keys to the secret strategy.
**No change** to `api`, the SDK, the realtime contract, or the web client.

## Exit criteria

Search "a ladder" → watch real text stream in → a real, photographic, plausible
ladder listing with consistent multi-angle images persists and is reusable; a
labeled dedup eval set passes target precision/recall; cost-per-cold-generation
is measured and within the budgeted band; moderation blocks a disallowed query
generically; the whole Stage 1 acceptance demo still passes unchanged.
