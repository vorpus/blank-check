import { QueryClient } from "@tanstack/react-query";

import { isApiError } from "./sdk";

/**
 * One `QueryClient` for the app (doc 03 §4). `staleTime` is generous because most
 * reads (`ready` listings, the catalog grid) are effectively immutable for the
 * session; cart/order hooks override with shorter times where freshness matters.
 *
 * Retries skip 4xx `ApiError`s (a `not_found`/`conflict` won't fix itself), but
 * retry transient 5xx/network blips once.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (isApiError(error) && error.status >= 400 && error.status < 500) {
            return false;
          }
          return failureCount < 1;
        },
      },
      mutations: {
        retry: false,
      },
    },
  });
}
