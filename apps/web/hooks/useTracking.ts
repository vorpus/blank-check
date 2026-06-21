"use client";

import { type Order, type RealtimeEvent } from "@dopamine/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useIdentity } from "@/app/providers";
import { qk } from "@/lib/queryKeys";
import { getTracking } from "@/lib/sdk";

/**
 * `useTracking(orderId)` — live order tracking via the SDK `TrackingClient`
 * (doc 03 §4, §7). The SDK owns the hard parts: snapshot-first catch-up, apply in
 * `seq` order, drop `seq <= lastApplied`, exponential-backoff reconnect, and the
 * polling fallback when SSE stays down. This hook only:
 *   - subscribes on mount / unsubscribes on unmount,
 *   - folds each `tracking_event` into the `qk.order(id)` cache (ONE data path,
 *     shared with `useOrder` + the polling fallback — doc 03 §4 "one data path"),
 *   - tracks a coarse `{ mode: 'live' | 'polling' }` for the connection badge.
 *
 * `degraded`/generation frames that arrive on this channel are ignored here (the
 * card-level `useGenerationMedia` owns those); tracking only applies state/display.
 */

export type TrackingMode = "live" | "polling";

interface UseTrackingResult {
  mode: TrackingMode;
}

export function useTracking(orderId: string): UseTrackingResult {
  const { ready } = useIdentity();
  const qc = useQueryClient();
  const [mode, setMode] = useState<TrackingMode>("live");

  // The TrackingClient synthesizes a `tracking_event` on each poll tick; once we
  // see one with no live SSE frame in between, we surface "polling". We infer the
  // mode from event cadence: SSE frames keep mode "live"; a gap that triggers the
  // SDK's poll path produces synthetic frames. The SDK doesn't expose mode
  // directly, so we mark "polling" after a silence window with continued frames.
  const lastFrameAt = useRef<number>(Date.now());

  useEffect(() => {
    if (!ready || !orderId) return;

    let silenceTimer: ReturnType<typeof setInterval> | null = null;

    const applyEvent = (e: RealtimeEvent): void => {
      lastFrameAt.current = Date.now();

      // Tracking frames carry the authoritative state + (often) the full display
      // block. Fold them into the order cache; everything else is ignored here.
      if (e.type !== "tracking_event") return;

      qc.setQueryData<Order>(qk.order(orderId), (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          state: e.state,
          // Server may resend the full ordered stage list; trust it when present.
          display: e.display ?? prev.display,
        };
      });
    };

    const sub = getTracking().trackOrder(orderId, applyEvent);

    // Heuristic mode badge: if frames keep arriving on the SDK's poll interval
    // (≈5s) we can't distinguish from steady SSE, so we treat a >12s gap followed
    // by renewed frames as the polling regime. This is a functional indicator;
    // the SDK is the source of truth for actual transport.
    silenceTimer = setInterval(() => {
      const since = Date.now() - lastFrameAt.current;
      setMode(since > 12_000 ? "polling" : "live");
    }, 4_000);

    return () => {
      sub.stop();
      if (silenceTimer) clearInterval(silenceTimer);
    };
  }, [ready, orderId, qc]);

  return { mode };
}
