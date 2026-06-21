import {
  type AddCartItem,
  type Cart,
  type DeviceIdentityResponse,
  type Listing,
  type Order,
  type SearchResult,
  type TrackingSnapshot,
  type UpdateCartItem,
} from "@dopamine/contracts";

/**
 * The platform-agnostic typed API client (doc 05 §5).
 *
 * Consumers depend on the `ApiClient` INTERFACE; `createRestApiClient` is one
 * REST implementation. The interface is identical for web (Stage 1) and mobile
 * (Stage 6): nothing browser- or node-specific leaks in — `fetch`/`getToken`
 * (and, for the TrackingClient, `EventSource`) are INJECTED. Every response is
 * `.parse()`d through the matching `@dopamine/contracts` Zod schema before it is
 * returned, so the SDK is the client-side boundary validator (rule §1.2).
 */
export interface ApiClientOptions {
  /** API origin, e.g. `http://localhost:8080`. No trailing slash required. */
  baseUrl: string;
  /** Current bearer token, or `null` before the identity bootstrap. */
  getToken: () => string | null;
  /** Injectable `fetch` (mobile / tests). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Params for `search` (typed by the generated `/v1/search` operation). */
export interface SearchParams {
  q: string;
  /** Optional — resolves to the default storefront server-side if omitted. */
  storefrontId?: string;
}

/** Body for `orders.place`. Place takes the active cart implicitly (doc 01 §7.3). */
export interface PlaceOrderInput {
  /** Optional — resolves the active cart's storefront (default if omitted). */
  storefrontId?: string;
}

/**
 * The typed surface. Each method returns a fully-parsed contract type; a non-2xx
 * response throws an `ApiError` (doc 05 §6) instead of resolving.
 */
export interface ApiClient {
  identity: {
    /** `POST /v1/identity/device` — bootstrap/resolve the anonymous device user. */
    device(deviceId?: string | null): Promise<DeviceIdentityResponse>;
  };
  /** `GET /v1/search` — blended grid + a generation hint on a miss. */
  search(params: SearchParams): Promise<SearchResult>;
  listings: {
    /** `GET /v1/listings/{id}`. */
    get(id: string): Promise<Listing>;
  };
  cart: {
    /** `GET /v1/cart` — the active cart for the device user + storefront. */
    get(storefrontId?: string): Promise<Cart>;
    /** `POST /v1/cart/items` — add a listing; returns the recomputed cart. */
    addItem(input: AddCartItem): Promise<Cart>;
    /** `PATCH /v1/cart/items/{id}` — change a line's quantity. */
    updateItem(id: string, input: UpdateCartItem): Promise<Cart>;
    /** `DELETE /v1/cart/items/{id}` — remove a line. */
    removeItem(id: string): Promise<Cart>;
  };
  orders: {
    /** `POST /v1/orders` with `Idempotency-Key` — idempotent on retry. */
    place(input: PlaceOrderInput, idempotencyKey: string): Promise<Order>;
    /** `GET /v1/orders/{id}` — the polling fallback for live tracking. */
    get(id: string): Promise<Order>;
    /** `GET /v1/orders` — the device user's orders, most recent first. */
    list(): Promise<Order[]>;
    /** `POST /v1/orders/{id}/cancel` — cancels if the machine allows (else 409). */
    cancel(id: string): Promise<Order>;
    /** `GET /v1/orders/{id}/tracking` — snapshot + ordered event log + latestSeq. */
    trackingSnapshot(id: string): Promise<TrackingSnapshot>;
  };
}
