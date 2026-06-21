import { digestHex, pick, rng, seed } from "./seed.js";

/**
 * Deterministic placeholder image generation (doc 02 §5).
 *
 * A placeholder image is a deterministic SVG: a seeded background colour, the
 * query text, and a "FAKE" watermark. SVG is ideal for Stage 1 — tiny,
 * text-based, no image libraries, fully deterministic. The `placeholder` (low-fi,
 * "generating…" tag) and the `final` (richer colour, no tag) are visibly
 * different so the placeholder → final swap is obvious in a demo.
 *
 * BOUNDARY (doc 02 §5.3 / charter §5.5.2): fake-gen returns image *bytes/URLs*;
 * it NEVER writes MinIO. It occupies the "provider" slot — a provider hands the
 * backend bytes to fetch, it does not write our bucket. The backend (its worker)
 * fetches `GET /img/...`, ingests to MinIO, and persists the MinIO URL.
 *
 * STAGE 2 SEAM: replace `svgPlaceholder` with Flux Schnell (fast placeholder) +
 * gpt-image-1.5 (final hero/alternates). The `/img/...` fetch URLs and the
 * `MediaAsset` shape they fill are unchanged, so the backend's ingestion code
 * does not move.
 */

export type ImageKind = "placeholder" | "final";

/** Escape the five XML-significant characters so query text can't break the SVG. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const PATTERNS = ["solid", "diag", "dots"] as const;

/**
 * A stable, content-addressed image key for `(query, variant, kind, slot)`.
 * `slot` distinguishes hero (`h`) from alternates (`a1`, `a2`, …). Because it is
 * deterministic, the URL is stable and the backend's content-addressed MinIO key
 * is stable too — re-ingesting is idempotent (doc 02 §5.3).
 */
export function imageKey(
  query: string,
  variant: number,
  kind: ImageKind,
  slot: string,
): string {
  return digestHex(`${kind}|${query}|${String(variant)}|${slot}`);
}

/** Render the deterministic placeholder/final SVG for a query+variant+slot. */
export function svgImage(
  query: string,
  variant: number,
  kind: ImageKind,
  slot: string,
): string {
  const r = rng(seed(query, `img:${slot}`, variant));
  const hue = Math.floor(r() * 360);
  const pattern = pick(r, PATTERNS);
  // `final` is richer/darker; `placeholder` is washed-out / low-fi.
  const bgL = kind === "final" ? 58 : 82;
  const bg = `hsl(${String(hue)} 48% ${String(bgL)}%)`;
  const bg2 = `hsl(${String((hue + 28) % 360)} 52% ${String(bgL - 12)}%)`;
  const fg = `hsl(${String(hue)} 60% 18%)`;
  const tag = kind === "final" ? "ready" : "generating…";
  const text = escapeXml(query.slice(0, 40)) || "fake";

  const defs =
    pattern === "diag"
      ? `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${bg2}"/>
        </linearGradient></defs>`
      : pattern === "dots"
        ? `<defs><pattern id="g" width="64" height="64" patternUnits="userSpaceOnUse">
            <rect width="64" height="64" fill="${bg}"/>
            <circle cx="16" cy="16" r="6" fill="${bg2}"/>
          </pattern></defs>`
        : "";
  const fill = pattern === "solid" ? bg : "url(#g)";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="${text}">
  ${defs}
  <rect width="1024" height="1024" fill="${fill}"/>
  <text x="512" y="500" font-family="system-ui, sans-serif" font-size="72" font-weight="700"
        fill="${fg}" text-anchor="middle" dominant-baseline="middle">${text}</text>
  <text x="512" y="600" font-family="system-ui, sans-serif" font-size="30"
        fill="${fg}" opacity="0.72" text-anchor="middle">${tag} · FAKE</text>
</svg>`;
}
