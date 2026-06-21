/**
 * `@dopamine/contracts` — the single source of truth for Stage-1 wire contracts.
 *
 * Every wire shape is declared once as a Zod schema; its TypeScript type is
 * inferred (`z.infer`), never hand-written in parallel. Backend, worker,
 * fake-gen, web, and the SDK all import from here. The only runtime dependency
 * is `zod`, so this package is safe in the browser bundle, the NestJS server,
 * and the tiny fake-gen service alike.
 *
 * Public surface (doc 05 §2.2 / §9): every schema + inferred type from §4–§8,
 * the ID helpers (§6.2), the Money helpers (§6.1), the error envelope (§6.3),
 * and the `GenerationProvider` interface (§4.2).
 */

// IDs (§6.2)
export {
  ID_PREFIXES,
  prefixedId,
  isPrefixedId,
  formatId,
  parseId,
  type IdEntity,
  type IdPrefix,
} from "./ids.js";

// Money (§6.1)
export {
  MoneySchema,
  money,
  sameCurrency,
  addMoney,
  multiplyMoney,
  type Money,
} from "./money.js";

// Errors (§6.3)
export { ErrorEnvelopeSchema, ERROR_CODES, type ErrorEnvelope, type ErrorCode } from "./errors.js";

// Enums (§4.1 / §4.2)
export {
  TrackingModeSchema,
  MediaStatusSchema,
  OriginSchema,
  GenerationStatusSchema,
  type TrackingMode,
  type MediaStatus,
  type Origin,
  type GenerationStatus,
} from "./enums.js";

// Media (§4.1)
export { MediaAssetSchema, MediaSchema, type MediaAsset, type Media } from "./media.js";

// Listing (§4.1)
export { ListingSchema, type Listing } from "./listing.js";

// Order (§4.1)
export {
  DisplayStageSchema,
  DisplayBlockSchema,
  CapabilitiesSchema,
  OrderItemSchema,
  OrderSchema,
  type DisplayStage,
  type DisplayBlock,
  type Capabilities,
  type OrderItem,
  type Order,
} from "./order.js";

// Search (§4.1)
export {
  SearchGenerationSchema,
  SearchResultSchema,
  type SearchGeneration,
  type SearchResult,
} from "./search.js";

// Generation (§4.2)
export {
  GenerationRequestSchema,
  GenerationResultSchema,
  GenerationGridRequestSchema,
  type GenerationRequest,
  type GenerationResult,
  type GenerationGridRequest,
  type GenerationProvider,
} from "./generation.js";

// Realtime (§4.3)
export {
  GeoPositionSchema,
  TrackingEventSchema,
  GeoEventSchema,
  ImagesReadySchema,
  ImagesDegradedSchema,
  GenTextDeltaSchema,
  GenTextDoneSchema,
  RealtimeEventSchema,
  type GeoPosition,
  type TrackingEvent,
  type GeoEvent,
  type ImagesReady,
  type ImagesDegraded,
  type GenTextDelta,
  type GenTextDone,
  type RealtimeEvent,
  type RealtimeEventType,
} from "./realtime.js";

// Identity (§4.4)
export {
  DeviceIdentityRequestSchema,
  BearerTokenSchema,
  DeviceIdentityResponseSchema,
  type DeviceIdentityRequest,
  type BearerToken,
  type DeviceIdentityResponse,
} from "./identity.js";

// Tracking snapshot (doc 05 §5.1 — ADDITIVE, Milestone 3b)
export { TrackingSnapshotSchema, type TrackingSnapshot } from "./tracking.js";
