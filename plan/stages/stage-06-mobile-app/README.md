# Stage 06 — Mobile App (iOS, then Android)

> **Status:** Planned. **Depends on:** Stage 01 contracts + SDK. Best after Stage
> 02 (inherits real generation UX) and Stage 04 (OAuth sign-in). RN sharing makes
> it cheap alongside Stage 03.
> **Goal:** a native-feeling iOS app — then Android nearly for free — that is
> "just another client of the same contracts."

Realizes architecture doc **03 §1** (cross-platform decision) and roadmap (Android).

## Approach

**Expo + React Native (New Architecture / Fabric-Bridgeless) for iOS & Android,
in the same TypeScript monorepo as web.** Share logic, data hooks, the API SDK,
the vertical/SDUI registry, design tokens, Zod validation, feature logic. Fork
only presentation leaves. Drop to **SwiftUI via Nitro/Fabric host views** on a
short, governed allowlist of hero screens (order-placed celebration; later, the
food courier map).

## Scope

- Expo app shell, Expo Router (typed, deep-linkable routes mapping to share
  links), native stack/tab transitions.
- The full loop on mobile: search → grid → listing → cart → checkout → timeline
  tracking — rendered from the **same `display.stages` data** (proves the
  vertical-agnostic contract on a second platform).
- SSE/polling tracking client on mobile network conditions (background, flaky
  connections) — polling fallback matters more here.
- Native auth (Stage 04 OAuth: Sign in with Apple / Google), guest mode.
- Generation UX on mobile (streaming, blurhash, cross-fade) reusing Stage 03 work.
- The one or two **SwiftUI escape-hatch** hero screens behind a documented props
  contract (JS stays source of truth).
- EAS build/submit pipeline; TestFlight.
- **Android**: turn it on — mostly QA + platform-leaf tuning, not a new codebase.

## Exit criteria

The iOS app runs the full loop natively against the same backend/SDK; tracking
works over real mobile networks with polling fallback; guest + OAuth sign-in
work; the generic client renders retail from server data with no platform-specific
state enum; Android builds and passes the same loop with only leaf-level tuning.
