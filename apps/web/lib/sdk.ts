import {
  type ApiClient,
  createRestApiClient,
  type EventSourceFactory,
  isApiError,
  type SseConnection,
  TrackingClient,
} from "@dopamine/sdk";

import { apiBaseUrl } from "./env";
import { getToken, refreshToken } from "./identity";

/**
 * The singleton typed SDK (doc 03 §4). One `ApiClient` for the whole app; the
 * auth hook (`getToken`) injects the device bearer on every request, and the
 * injected `fetch` transparently re-bootstraps the token once on a 401 (doc 03
 * §8 "on a 401, re-issue the token for the same deviceId and retry once").
 *
 * Components NEVER call `fetch` or the SDK directly — they go through the hooks,
 * which call this client. The SDK already Zod-parses every response, so hooks
 * treat the returned value as trusted and only handle `ApiError`.
 */

/**
 * `fetch` wrapper that retries ONCE on a 401 after refreshing the token. The SDK
 * throws `ApiError` (status 401) on an expired token; but the refresh has to
 * happen at the transport layer so the SDK's already-built request carries the
 * new bearer. We intercept the raw `Response` here instead.
 */
const fetchWith401Retry: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (res.status !== 401) return res;

  // Re-issue a token for the same device, then replay the request with it.
  try {
    const id = await refreshToken();
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${id.accessToken}`);
    return await fetch(input, { ...init, headers });
  } catch {
    // Refresh failed — surface the original 401 to the SDK error path.
    return res;
  }
};

let apiSingleton: ApiClient | null = null;

/** The shared `ApiClient`. Lazily constructed so SSR + client share one config. */
export function getApi(): ApiClient {
  if (!apiSingleton) {
    apiSingleton = createRestApiClient({
      baseUrl: apiBaseUrl(),
      getToken,
      fetch: fetchWith401Retry,
    });
  }
  return apiSingleton;
}

/**
 * Adapt the browser's native `EventSource` to the SDK's structural `SseConnection`.
 * The DOM `MessageEvent` carries `data: string` + `lastEventId: string`, which is
 * exactly the `SseMessageEvent` subset the SDK reads — so the bridge is a thin
 * type adapter, no runtime translation.
 */
const browserEventSourceFactory: EventSourceFactory = (url) =>
  new EventSource(url) as unknown as SseConnection;

let trackingSingleton: TrackingClient | null = null;

/**
 * The shared realtime client (order tracking + generation image swaps). Browser
 * only — `EventSource` is a DOM global. Callers must guard `typeof window`.
 */
export function getTracking(): TrackingClient {
  if (typeof window === "undefined") {
    throw new Error("TrackingClient is browser-only (needs EventSource)");
  }
  if (!trackingSingleton) {
    trackingSingleton = new TrackingClient({
      api: getApi(),
      baseUrl: apiBaseUrl(),
      getToken,
      eventSourceFactory: browserEventSourceFactory,
    });
  }
  return trackingSingleton;
}

export { isApiError };
