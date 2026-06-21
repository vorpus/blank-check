"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import { bootstrapIdentity } from "@/lib/identity";
import { makeQueryClient } from "@/lib/queryClient";

/**
 * App-wide client providers (doc 03 §3, §8):
 *   - ONE `QueryClient` (stable across renders via a ref).
 *   - The anonymous identity bootstrap, run once on mount BEFORE authed queries
 *     can succeed. We expose readiness via context so screens can hold their
 *     first authed fetch until a token exists (avoids a guaranteed-401 round-trip).
 *
 * The bootstrap is fire-once and idempotent (lib/identity de-dupes), so React 18
 * StrictMode's double-invoke is harmless.
 */

interface IdentityState {
  /** True once a device token has been issued and the SDK can authenticate. */
  ready: boolean;
  /** Set if the bootstrap failed (network down / api unreachable). */
  error: string | null;
}

const IdentityContext = createContext<IdentityState>({
  ready: false,
  error: null,
});

/** Read identity readiness. Hooks gate their first authed fetch on `ready`. */
export function useIdentity(): IdentityState {
  return useContext(IdentityContext);
}

export function Providers({ children }: { children: React.ReactNode }) {
  // A stable QueryClient per browser session (never recreated on re-render).
  const clientRef = useRef(makeQueryClient());

  const [identity, setIdentity] = useState<IdentityState>({
    ready: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    bootstrapIdentity()
      .then(() => {
        if (!cancelled) setIdentity({ ready: true, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setIdentity({
            ready: false,
            error: err instanceof Error ? err.message : "identity failed",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <QueryClientProvider client={clientRef.current}>
      <IdentityContext.Provider value={identity}>
        {children}
      </IdentityContext.Provider>
    </QueryClientProvider>
  );
}
