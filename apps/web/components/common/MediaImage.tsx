"use client";

import { type Media } from "@dopamine/contracts";
import { useEffect, useState } from "react";

/**
 * `MediaImage` — DATA-DRIVEN media renderer (doc 03 §5.1, §6.2). Renders purely
 * from `media.status` + `media.hero`; it knows nothing about verticals or order
 * state. The three (+1) states:
 *
 *   generating_text  → no hero yet: a neutral placeholder box (text-first render).
 *   generating_media → placeholder hero (if any) + a plain "loading" indicator.
 *                      The card is fully interactive/orderable in this state.
 *   ready            → the final hero, opacity-faded in.
 *   degraded         → NOT an error: the kept placeholder/last hero, fully usable.
 *
 * The aspect-ratio box is reserved up front so the placeholder→final swap causes
 * NO layout shift (a correctness concern — ships now, doc 03 §6.2). A functional
 * CSS opacity cross-fade is fine; the choreographed reveal is Stage 3 `[→S3]`.
 */
export function MediaImage({
  media,
  alt,
  className,
  sizes,
}: {
  media: Media;
  alt: string;
  className?: string;
  /** Aspect-ratio hint override; defaults to the asset's ratio (or 1). */
  sizes?: string;
}) {
  const hero = media.hero;
  const aspect = hero?.aspect_ratio ?? 1;
  const loadingMedia = media.status === "generating_media";
  const noHero = media.status === "generating_text" || hero === null;

  // Track when the <img> has actually decoded so the fade targets the real pixels.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
  }, [hero?.url]);

  return (
    <div
      className={`relative overflow-hidden rounded-lg bg-neutral-100 ${className ?? ""}`}
      style={{ aspectRatio: String(aspect) }}
    >
      {noHero ? (
        // generating_text: nothing to show yet — a calm neutral box.
        <div
          className="absolute inset-0 grid place-items-center text-xs text-neutral-400"
          aria-hidden="true"
        >
          <span>preparing…</span>
        </div>
      ) : (
        // NOTE: a plain <img> (not next/image) — fake-gen serves SVG over plain
        // HTTP; Stage 1 avoids a next/image loader + remote allowlist. [→S3] can
        // revisit for optimization once heroes are real raster images.
        <img
          src={hero.url}
          alt={alt}
          sizes={sizes}
          onLoad={() => setLoaded(true)}
          // Functional cross-fade only ([→S3] for choreography). Reserve box above
          // means no layout shift regardless of load state.
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
        />
      )}

      {loadingMedia && (
        // Plain "loading" indicator (no shimmer/spinner choreography — [→S3]).
        <div className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white">
          loading…
        </div>
      )}
    </div>
  );
}
