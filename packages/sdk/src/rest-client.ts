import {
  AddCartItemSchema,
  CartSchema,
  DeviceIdentityResponseSchema,
  ListingSchema,
  OrderSchema,
  SearchResultSchema,
  TrackingSnapshotSchema,
  UpdateCartItemSchema,
  type AddCartItem,
  type Order,
  type UpdateCartItem,
} from "@dopamine/contracts";
import { z } from "zod";

import {
  type ApiClient,
  type ApiClientOptions,
  type PlaceOrderInput,
  type SearchParams,
} from "./client.js";
import { toApiError } from "./errors.js";
import { type paths } from "./openapi.gen.js";

/**
 * The one REST implementation of `ApiClient` (doc 05 §5).
 *
 * DRY core: a single `req<T>()` does fetch + auth + (non-2xx → ApiError) + Zod
 * parse, so every method is one line that names its path and its response schema.
 * The generated `paths` type (`openapi.gen.ts`) types the URL/param/response
 * triples at the call sites (compile time, zero runtime); the Zod schemas validate
 * the bodies (runtime). The implementation is platform-agnostic — `fetch` and
 * `getToken` are injected (mobile supplies its own in Stage 6).
 *
 * `paths` is referenced via `PathsCheck` below so the generated spec is a
 * compile-time gate on these endpoints: if a path/method this client calls is
 * renamed or removed in the spec, the SDK fails to typecheck (the drift signal).
 */

/** A minimal validator shape so `req` accepts any contract Zod schema. */
interface Parser<T> {
  parse(input: unknown): T;
}

export function createRestApiClient(opts: ApiClientOptions): ApiClient {
  const doFetch: typeof fetch = opts.fetch ?? globalThis.fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");

  /** fetch + auth + error mapping + boundary parse — the whole REST core. */
  async function req<T>(
    path: string,
    init: RequestInit,
    schema: Parser<T>,
  ): Promise<T> {
    const token = opts.getToken();
    const headers = new Headers(init.headers);
    if (!headers.has("content-type") && init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (token && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }

    const res = await doFetch(base + path, { ...init, headers });
    if (!res.ok) {
      throw await toApiError(res);
    }
    return schema.parse(await res.json());
  }

  return {
    identity: {
      device: (deviceId = null) =>
        req(
          "/v1/identity/device",
          { method: "POST", body: JSON.stringify({ deviceId }) },
          DeviceIdentityResponseSchema,
        ),
    },

    search: (params: SearchParams) => {
      const qs = new URLSearchParams({ q: params.q });
      if (params.storefrontId !== undefined)
        qs.set("storefrontId", params.storefrontId);
      return req(
        `/v1/search?${qs.toString()}`,
        { method: "GET" },
        SearchResultSchema,
      );
    },

    listings: {
      get: (id: string) =>
        req(
          `/v1/listings/${encodeURIComponent(id)}`,
          { method: "GET" },
          ListingSchema,
        ),
    },

    cart: {
      get: (storefrontId?: string) => {
        const qs = new URLSearchParams();
        if (storefrontId !== undefined) qs.set("storefrontId", storefrontId);
        const suffix = qs.toString() ? `?${qs.toString()}` : "";
        return req(`/v1/cart${suffix}`, { method: "GET" }, CartSchema);
      },
      addItem: (input: AddCartItem) =>
        req(
          "/v1/cart/items",
          {
            method: "POST",
            body: JSON.stringify(AddCartItemSchema.parse(input)),
          },
          CartSchema,
        ),
      updateItem: (id: string, input: UpdateCartItem) =>
        req(
          `/v1/cart/items/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            body: JSON.stringify(UpdateCartItemSchema.parse(input)),
          },
          CartSchema,
        ),
      removeItem: (id: string) =>
        req(
          `/v1/cart/items/${encodeURIComponent(id)}`,
          { method: "DELETE" },
          CartSchema,
        ),
    },

    orders: {
      place: (input: PlaceOrderInput, idempotencyKey: string) =>
        req(
          "/v1/orders",
          {
            method: "POST",
            headers: { "Idempotency-Key": idempotencyKey },
            body: JSON.stringify(input),
          },
          OrderSchema,
        ),
      get: (id: string) =>
        req(
          `/v1/orders/${encodeURIComponent(id)}`,
          { method: "GET" },
          OrderSchema,
        ),
      list: () =>
        req(
          "/v1/orders",
          { method: "GET" },
          z.array(OrderSchema) as Parser<Order[]>,
        ),
      cancel: (id: string) =>
        req(
          `/v1/orders/${encodeURIComponent(id)}/cancel`,
          { method: "POST" },
          OrderSchema,
        ),
      trackingSnapshot: (id: string) =>
        req(
          `/v1/orders/${encodeURIComponent(id)}/tracking`,
          { method: "GET" },
          TrackingSnapshotSchema,
        ),
    },
  };
}

/**
 * Compile-time assertion that every path/method this client calls exists in the
 * generated spec. Purely a type-level check (erased at build): if the spec drops
 * or renames one of these operations, this object stops typechecking — surfacing
 * transport drift before it reaches a consumer. Not exported; never executed.
 */
type _PathsCheck = [
  paths["/v1/identity/device"]["post"],
  paths["/v1/search"]["get"],
  paths["/v1/listings/{id}"]["get"],
  paths["/v1/cart"]["get"],
  paths["/v1/cart/items"]["post"],
  paths["/v1/cart/items/{id}"]["patch"],
  paths["/v1/cart/items/{id}"]["delete"],
  paths["/v1/orders"]["post"],
  paths["/v1/orders"]["get"],
  paths["/v1/orders/{id}"]["get"],
  paths["/v1/orders/{id}/cancel"]["post"],
  paths["/v1/orders/{id}/tracking"]["get"],
  paths["/v1/orders/{id}/stream"]["get"],
  paths["/v1/generation/{generationId}/stream"]["get"],
];
