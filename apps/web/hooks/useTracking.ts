"use client";

import { type Order, type RealtimeEvent } from "@dopamine/contracts";
import { type TransportMode } from "@dopamine/sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

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
 *   - mirrors the SDK's REAL transport mode for the connection badge.
 *
 * The badge mode is read straight off the subscription (`getMode`/`onModeChange`)
 * — the SDK is the source of truth for the transport, so there's no cadence
 * heuristic here. The SDK's transient `connecting` state is shown as `live` (the
 * badge has two states); only the genuine polling fallback flips it to `polling`.
 *
 * `degraded`/generation frames that arrive on this channel are ignored here (the
 * card-level `useGenerationMedia` owns those); tracking only applies state/display.
 */

export type TrackingMode = "live" | "polling";

interface UseTrackingResult {
  mode: TrackingMode;
}

/** The badge has two states; "connecting" is shown optimistically as "live". */
function toBadgeMode(mode: TransportMode): TrackingMode {
  return mode === "polling" ? "polling" : "live";
}

export function useTracking(orderId: string): UseTrackingResult {
  const { ready } = useIdentity();
  const qc = useQueryClient();
  const [mode, setMode] = useState<TrackingMode>("live");

  useEffect(() => {
    if (!ready || !orderId) return;

    const applyEvent = (e: RealtimeEvent): void => {
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

    // Mirror the SDK's actual transport mode (no cadence guessing).
    setMode(toBadgeMode(sub.getMode()));
    const unsubscribe = sub.onModeChange((m) => setMode(toBadgeMode(m)));

    return () => {
      unsubscribe();
      sub.stop();
    };
  }, [ready, orderId, qc]);

  return { mode };
}
