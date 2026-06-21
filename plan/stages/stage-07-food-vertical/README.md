# Stage 07 — Food Vertical (Extensibility Proof + Live Courier Map)

> **Status:** Planned. **Depends on:** the platform seams from Stages 01–02 being
> solid; the geo/map renderer benefits from Stage 06 (mobile) but works on web.
> **Goal:** add **food ordering** as purely **additive strategies** plus live
> courier-on-a-map tracking — the architecture's own acceptance test.

Realizes architecture doc **06** (adding a vertical) and **04 §4** (geo tracking).

## The whole point

This stage exists to *prove the architecture*. Success is measured by what we
**don't** have to change: **no DB migration, no API version bump, no edits to
cart, orders, search, the generation pipeline, the realtime transport, or the
existing clients.** Adding food = config + three strategy classes + one map
renderer. If any of that requires touching core code, the abstraction leaked and
that's the bug to fix.

## Scope (follow architecture doc 06 step by step)

- **Register the `food` vertical:** config + strategy wiring in the registry.
- **`FoodGenerationStrategy`:** menu-item prompt + schema variant (dish,
  ingredients, allergens, dietary tags, plating image style) — or curated menus
  if generation is disabled for food per `catalogPolicy`.
- **`FoodFulfillmentStrategy`:** the fast minute-scale state machine
  (`placed→confirmed→cooking→courier_assigned→en_route→arrived→delivered`).
- **`FoodTrackingProvider`:** `trackingMode: "map"`, `emitsGeo()`, a `geoPlan()`
  producing a route.
- **Geo infra:** self-hosted **OSRM** route service container; a high-frequency
  `order:{id}:geo` channel emitting `geo_position` at 1–2s.
- **Client `LiveCourierMap`:** MapLibre + MapTiler renderer registered for
  `trackingMode: map`, courier marker interpolation between geo frames; the
  generic client picks it up via `capabilities.liveLocation`.

## Exit criteria

Order food → lifecycle advances in minutes → a courier moves smoothly on a live
map (interpolated between 1–2s geo frames) on web (and mobile if Stage 06 done) —
**and** a diff review confirms the change was additive only: new vertical
config + 3 strategy classes + 1 map renderer + OSRM container, with zero edits to
core modules, the order schema, or the API version. That diff *is* the proof.
