# Stage 03 — Frontend Depth & Dopamine Polish

> **Status:** Planned. **Depends on:** Stage 01 (screens exist). Overlaps Stage 02.
> **Goal:** make the app *feel* great — the whole reason the product exists. Turn
> the functional Stage 1 UI into a delightful, highly-animated, satisfying
> experience.

Realizes architecture doc **03 §6** ("dopamine" polish) and roadmap **Phase 3**.

## Why a dedicated stage

Stage 1 deliberately ships *functional* states (skeleton / placeholder / ready)
with no choreography. "Feel" is the product's entire differentiator, so it earns
its own focused, highly-parallelizable stage rather than being smeared thinly.

## Scope

- **Animation system** per platform (Reanimated / Framer Motion on web), shared
  motion tokens (curves, durations) authored once.
- **The order-placed celebration** — the signature dopamine moment.
- **Celebratory tracking transitions** as stages advance.
- **Generation UX richness:** live streaming-token render (typing card), blurhash
  → placeholder → final **cross-fade** swap, "enhancing photos" shimmer, grids
  that visibly *populate* as listings stream in (arch 02 §1.4 client rules 6–8).
- **Haptics + sound** as semantic "intents" behind a platform adapter.
- **Micro-interactions** (add-to-cart, quantity, pull-to-refresh, skeletons).
- **Perceived-performance** tricks: optimistic UI, prefetch, suspense boundaries.
- **Accessibility** pass: reduced-motion, screen-reader labels, contrast, focus.
- **Design-system maturity:** tokens → components, Style Dictionary emit.

## Notes

Highly parallelizable across contributors (individual animations, sound design,
haptic tuning, a11y audits). Most work is pure presentation-layer; it must not
require contract changes — if it does, that's a smell.

## Exit criteria

The order-placement moment delights; generation visibly streams and cross-fades;
reduced-motion and screen-reader paths are clean; a design-token source of truth
drives the components; no new backend contract was needed.
