import { describe, expect, it, vi } from "vitest";

import { ApiError } from "./errors.js";
import { createRestApiClient } from "./rest-client.js";

/** A valid contract `Order` body for happy-path parse tests. */
function orderBody(id = "ord_01J0000000000000000000000") {
  return {
    id,
    verticalId: "retail",
    storefrontId: "sto_01J0000000000000000000000",
    state: "confirmed",
    items: [
      {
        id: "oit_01J0000000000000000000000",
        listingId: "lst_01J0000000000000000000000",
        titleSnapshot: "Blue Widget",
        unitPriceSnapshot: { amount_cents: 1299, currency: "USD" },
        qty: 2,
      },
    ],
    total: { amount_cents: 2598, currency: "USD" },
    display: {
      stages: [
        { key: "confirmed", label: "Confirmed", reached: true, current: true },
      ],
      trackingMode: "timeline",
    },
    capabilities: { liveLocation: false },
    streamUrl: `/v1/orders/${id}/stream`,
    placedAt: "2026-06-21T12:00:00.000Z",
  };
}

function cartBody() {
  return {
    id: "crt_01J0000000000000000000000",
    storefrontId: "sto_01J0000000000000000000000",
    status: "active",
    version: 3,
    items: [],
    subtotal: { amount_cents: 0, currency: "USD" },
    currency: "USD",
    updatedAt: "2026-06-21T12:00:00.000Z",
  };
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

/** A typed fetch mock whose `mock.calls` are `[input, init]` tuples. */
function fetchMockFor(impl: () => Response) {
  return vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >(() => Promise.resolve(impl()));
}

describe("createRestApiClient — URL + headers", () => {
  it("builds the order URL, sends bearer + Idempotency-Key on place", async () => {
    const fetchMock = fetchMockFor(() => jsonResponse(orderBody()));
    const client = createRestApiClient({
      baseUrl: "http://api.test",
      getToken: () => "tok_123",
      fetch: fetchMock,
    });

    await client.orders.place({ storefrontId: "sto_x" }, "idem-key-abc");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/v1/orders");
    expect(init!.method).toBe("POST");
    const headers = init!.headers as Headers;
    expect(headers.get("idempotency-key")).toBe("idem-key-abc");
    expect(headers.get("authorization")).toBe("Bearer tok_123");
    expect(headers.get("content-type")).toBe("application/json");
    expect(init!.body).toBe(JSON.stringify({ storefrontId: "sto_x" }));
  });

  it("encodes search query params and omits auth when no token", async () => {
    const fetchMock = fetchMockFor(() =>
      jsonResponse({ listings: [], generation: null }),
    );
    const client = createRestApiClient({
      baseUrl: "http://api.test/",
      getToken: () => null,
      fetch: fetchMock,
    });

    await client.search({ q: "red shoes & socks", storefrontId: "sto_1" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "http://api.test/v1/search?q=red+shoes+%26+socks&storefrontId=sto_1",
    );
    expect((init!.headers as Headers).has("authorization")).toBe(false);
  });

  it("strips a trailing slash from baseUrl", async () => {
    const fetchMock = fetchMockFor(() => jsonResponse(cartBody()));
    const client = createRestApiClient({
      baseUrl: "http://api.test///",
      getToken: () => "t",
      fetch: fetchMock,
    });
    await client.cart.get();
    expect(fetchMock.mock.calls[0]![0]).toBe("http://api.test/v1/cart");
  });
});

describe("createRestApiClient — boundary validation", () => {
  it("parses a good response and returns the typed contract value", async () => {
    const fetchMock = fetchMockFor(() =>
      jsonResponse(orderBody("ord_01JABCDEFGHJKMNPQRSTVWXYZ0")),
    );
    const client = createRestApiClient({
      baseUrl: "http://api.test",
      getToken: () => "t",
      fetch: fetchMock,
    });

    const order = await client.orders.get("ord_01JABCDEFGHJKMNPQRSTVWXYZ0");
    expect(order.id).toBe("ord_01JABCDEFGHJKMNPQRSTVWXYZ0");
    expect(order.total.amount_cents).toBe(2598);
  });

  it("THROWS when the response body is malformed (boundary catches server bugs)", async () => {
    // Missing `total` / `items` — not a valid Order.
    const bad = { id: "ord_x", state: "confirmed" };
    const fetchMock = fetchMockFor(() => jsonResponse(bad));
    const client = createRestApiClient({
      baseUrl: "http://api.test",
      getToken: () => "t",
      fetch: fetchMock,
    });

    await expect(client.orders.get("ord_x")).rejects.toThrow();
  });
});

describe("createRestApiClient — error envelope → ApiError", () => {
  it("turns a non-2xx ErrorEnvelope into a typed ApiError", async () => {
    const envelope = {
      error: {
        code: "not_found",
        message: "order not found",
        requestId: "req_abc",
        details: { id: "ord_missing" },
      },
    };
    const fetchMock = fetchMockFor(() =>
      jsonResponse(envelope, { status: 404 }),
    );
    const client = createRestApiClient({
      baseUrl: "http://api.test",
      getToken: () => "t",
      fetch: fetchMock,
    });

    const err = await client.orders.get("ord_missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe("not_found");
    expect(apiErr.status).toBe(404);
    expect(apiErr.requestId).toBe("req_abc");
    expect(apiErr.message).toBe("order not found");
    expect(apiErr.details).toEqual({ id: "ord_missing" });
  });

  it("synthesizes a typed ApiError when the error body is not an envelope", async () => {
    const fetchMock = fetchMockFor(
      () =>
        new Response("<html>502</html>", {
          status: 502,
          statusText: "Bad Gateway",
        }),
    );
    const client = createRestApiClient({
      baseUrl: "http://api.test",
      getToken: () => "t",
      fetch: fetchMock,
    });

    const err = (await client.orders
      .get("ord_x")
      .catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBe("http_502");
    expect(err.requestId).toBe("unknown");
  });
});
