/**
 * `@dopamine/sdk` — the typed, platform-agnostic API client (doc 05 §5).
 *
 * Public surface:
 *   - `ApiClient` interface + `createRestApiClient(opts)` — one REST impl whose
 *     every method `.parse()`s its response through the matching
 *     `@dopamine/contracts` Zod schema (the client-side boundary validator).
 *   - `TrackingClient` — SSE catch-up/replay with backoff → polling fallback, for
 *     order tracking AND generation image swaps (shared core).
 *   - `ApiError` — the typed error every non-2xx response becomes.
 *   - The generated transport types (`paths`/`components`/`operations`) for
 *     consumers that want to reference the spec directly.
 *
 * The only runtime dependency is `@dopamine/contracts` (+ zod transitively);
 * `openapi.gen.ts` is types-only and erases at build. `fetch`/`getToken`/
 * `EventSource` are injected, so the surface is identical for web (Stage 1) and
 * mobile (Stage 6).
 */

// REST client
export {
  type ApiClient,
  type ApiClientOptions,
  type SearchParams,
  type PlaceOrderInput,
} from "./client.js";
export { createRestApiClient } from "./rest-client.js";

// Errors
export { ApiError, isApiError, toApiError } from "./errors.js";

// Tracking / realtime
export {
  TrackingClient,
  type TrackingClientOptions,
  type BackoffOptions,
  type Subscription,
} from "./tracking-client.js";
export {
  type EventSourceFactory,
  type SseConnection,
  type SseInit,
  type SseMessageEvent,
} from "./event-source.js";

// Generated transport types (zero runtime; for consumers referencing the spec).
export type { paths, components, operations } from "./openapi.gen.js";
