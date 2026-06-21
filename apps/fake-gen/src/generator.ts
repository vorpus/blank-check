import {
  type GenerationGridRequest,
  type GenerationResult,
  type Listing,
  type Media,
  type MediaAsset,
  type MediaStatus,
  type Money,
} from "@dopamine/contracts";

import { imageKey, type ImageKind } from "./images.js";
import { pick, rng, seed } from "./seed.js";

/**
 * The pure content generator — the heart of fake-gen and the explicit Stage 2
 * seam.
 *
 * This module is a pure function `(query, vertical, count) → GenerationResult[]`.
 * It performs NO I/O: no network, no clock, no MinIO, no Redis, no persistence.
 * Everything is derived deterministically from the request (doc 02 §1.1, §3).
 *
 * STAGE 2 SEAM — this file is what gets swapped:
 *   - `fakeListingText()` → a Claude structured-output call.
 *   - the placeholder image refs → Flux Schnell + gpt-image-1.5 outputs.
 *   - the title-collision de-dupe → embedding de-dupe before persist.
 * The HTTP contract this produces (`GenerationResult`, the `Media` states, the
 * `origin` union) is identical across stages, so `api` does not change a line.
 */

const BRANDS = [
  "ProReach",
  "Acme",
  "NorthPeak",
  "EverBuild",
  "Vantage",
  "Koto",
  "Brightline",
  "Halcyon",
] as const;
const MATERIALS = [
  "Aluminum",
  "Steel",
  "Bamboo",
  "Recycled Plastic",
  "Carbon Fiber",
  "Oak",
] as const;
const QUALIFIERS = ["Heavy-Duty", "Compact", "Premium", "Eco", "Pro-Grade", "Everyday"] as const;
const STYLES = ["industrial", "minimalist", "rustic", "modern", "matte"] as const;

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Options shared by every result a single `/generate` (or grid) call produces. */
export interface BuildOptions {
  /** Public base URL of this service, used to build fetchable `/img/...` URLs. */
  publicBaseUrl: string;
  /** Hint surfaced as `media.expected_ready_ms` (= FAKE_MEDIA_DELAY_MS). */
  expectedReadyMs: number;
  /** `generating_media` (two-phase) or `ready` (inline). */
  status: MediaStatus;
}

/** The deterministic listing *text* — the part Claude produces in Stage 2. */
interface ListingText {
  title: string;
  description: string;
  category: string;
  bullet_specs: string[];
  attributes: { key: string; value: string }[];
  price: Money;
  image_prompts: { hero: string; alternates: string[]; style_tokens: string[] };
}

function fakeListingText(query: string, vertical: string, variant: number): ListingText {
  const r = rng(seed(query, vertical, variant));
  const brand = pick(r, BRANDS);
  const material = pick(r, MATERIALS);
  const qualifier = pick(r, QUALIFIERS);
  const style = pick(r, STYLES);
  const noun = titleCase(query.trim() || "thing");

  // Price as integer cents (Money), in a plausible retail band — never floats.
  const baseCents = (15 + Math.floor(r() * 285)) * 100;
  const spreadCents = (10 + Math.floor(r() * 40)) * 100;

  return {
    title: `${brand} ${qualifier} ${material} ${noun}`.slice(0, 80),
    description:
      `Meet the ${brand} ${qualifier} ${noun}. Built from ${material.toLowerCase()} for a ` +
      `${style} look that lasts, it's the ${noun.toLowerCase()} a simulated shopper actually wants. ` +
      `Every detail is fictional — and proud of it.`,
    category: `${titleCase(vertical)} > ${noun}s`,
    bullet_specs: [
      `${material} construction`,
      `${qualifier} build quality`,
      `${style} finish`,
      "Fits the way you fake-shop",
    ],
    attributes: [
      { key: "Brand", value: brand },
      { key: "Material", value: material },
      { key: "Style", value: style },
    ],
    price: { amount_cents: baseCents + spreadCents, currency: "USD" },
    image_prompts: {
      hero: `studio product photo of a ${material.toLowerCase()} ${query}, ${style}, neutral background`,
      alternates: [`close-up detail of a ${material.toLowerCase()} ${query}`],
      style_tokens: [material.toLowerCase(), style, "studio lighting"],
    },
  };
}

/**
 * Build a `MediaAsset` whose `source` block instructs the backend to fetch the
 * deterministic SVG from this service and ingest it to MinIO.
 *
 * The fetch instruction (`source.ingest`/`source.url`) and the placeholder
 * `image_prompts` ride in `attributes` (JSONB on the listing) rather than as
 * top-level `MediaAsset` fields, because the canonical `MediaAssetSchema`
 * (doc 05 §4.1) is intentionally thin (`url`/`kind`/`blurhash`/`aspect_ratio`).
 * `MediaAsset.url` itself is the directly-fetchable provider URL — the backend
 * fetches it, ingests, and overwrites it with the MinIO URL on persist.
 */
function mediaAsset(
  query: string,
  variant: number,
  kind: ImageKind,
  slot: string,
  baseUrl: string,
): MediaAsset {
  const dir = kind === "final" ? "fin" : "ph";
  const key = imageKey(query, variant, kind, slot);
  return {
    url: `${baseUrl}/img/${dir}/${key}.svg`,
    kind: "image",
    blurhash: null, // Stage 1: flat placeholder, no blurhash (doc 05 §8.2)
    aspect_ratio: 1, // square
  };
}

/** The placeholder `Media` block returned by the fast path (`generating_media`). */
function placeholderMedia(
  query: string,
  variant: number,
  generationId: string,
  opts: BuildOptions,
): Media {
  const inline = opts.status === "ready";
  const kind: ImageKind = inline ? "final" : "placeholder";
  return {
    status: opts.status,
    hero: mediaAsset(query, variant, kind, "h", opts.publicBaseUrl),
    alternates: inline ? [mediaAsset(query, variant, "final", "a1", opts.publicBaseUrl)] : [],
    expected_ready_ms: inline ? null : opts.expectedReadyMs,
    generation_id: generationId,
  };
}

/** The enriched (final) `Media` block returned by `GET /media/:generationId`. */
export function finalMedia(
  query: string,
  variant: number,
  generationId: string,
  baseUrl: string,
  outcome: "ready" | "degraded",
): Media {
  if (outcome === "degraded") {
    // Rule 4 (arch 02 §1.4): the listing stays fully usable; the hero is left as
    // the placeholder. status flips to `degraded`, never an error.
    return {
      status: "degraded",
      hero: mediaAsset(query, variant, "placeholder", "h", baseUrl),
      alternates: [],
      expected_ready_ms: null,
      generation_id: generationId,
    };
  }
  return {
    status: "ready",
    hero: mediaAsset(query, variant, "final", "h", baseUrl),
    alternates: [mediaAsset(query, variant, "final", "a1", baseUrl)],
    expected_ready_ms: null,
    generation_id: generationId,
  };
}

/**
 * Build one `GenerationResult` for a single variant.
 *
 * `listing_id` (top-level) is `null` — fake-gen does NOT mint ids; the backend
 * mints them on persist (charter §5.5.1). The nested `listing.id` is a stable
 * provider-side ref derived from the generation id, so the full `ListingSchema`
 * still parses; the backend overwrites it on the transactional write.
 */
export function buildResult(
  query: string,
  vertical: string,
  variant: number,
  generationId: string,
  opts: BuildOptions,
): GenerationResult {
  const text = fakeListingText(query, vertical, variant);
  const media = placeholderMedia(query, variant, generationId, opts);

  const listing: Listing = {
    id: generationId, // provider-side per-listing ref; backend re-mints (lst_…) on persist
    verticalId: vertical,
    storefrontId: "", // backend owns the storefront association on persist
    title: text.title,
    description: text.description,
    price: text.price,
    attributes: {
      category: text.category,
      bullet_specs: text.bullet_specs,
      spec_attributes: text.attributes,
      image_prompts: text.image_prompts, // pass-through; Stage 2 image model consumes these
      client_ref: `g${String(variant)}`, // stable within-batch handle for correlation
    },
    media,
    origin: "generated", // fake-gen ALWAYS authors `generated` (charter §5.5.5)
    canonicalQuery: query,
    embedding: null, // RESERVED (Stage 2 pgvector)
    createdAt: "1970-01-01T00:00:00.000Z", // deterministic; backend stamps the real time
  };

  return {
    listing_id: null,
    generation_id: generationId,
    origin: "generated",
    status: opts.status,
    listing,
  };
}

/**
 * Produce N distinct variants for one query (the `generateGrid` provider method,
 * doc 02 §4). Distinctness comes free from the per-variant seed; we additionally
 * guard against an accidental title collision by deterministically re-rolling
 * the variant index — the Stage-1 equivalent of the real pipeline's embedding
 * de-dupe before persist.
 */
export function buildBatch(
  req: Pick<GenerationGridRequest, "query" | "vertical" | "count">,
  generationIdFor: (variant: number) => string,
  opts: BuildOptions,
): GenerationResult[] {
  const results: GenerationResult[] = [];
  const seenTitles = new Set<string>();
  for (let i = 0; i < req.count; i++) {
    let variant = i;
    let result = buildResult(req.query, req.vertical, variant, generationIdFor(i), opts);
    // Deterministic de-dupe: if the title collides, re-roll the variant index.
    let guard = 0;
    while (seenTitles.has(result.listing.title) && guard < req.count + 8) {
      variant += req.count;
      result = buildResult(req.query, req.vertical, variant, generationIdFor(i), opts);
      guard++;
    }
    seenTitles.add(result.listing.title);
    results.push(result);
  }
  return results;
}
