import { type Order } from "@dopamine/contracts";
import { type ReactElement } from "react";

import { TimelineRenderer } from "./TimelineRenderer";

/**
 * The `TrackingRenderer` registry (doc 03 §5.3, charter §4.1/§6.5).
 *
 * The order payload carries `display.trackingMode`. The client owns a registry
 * keyed on that mode and dispatches to the matching renderer. This is the bounded,
 * web-only form of the architecture's renderer registry.
 *
 *   - Stage 1 registers ONLY `'timeline'`.
 *   - The `'map'` slot is RESERVED for Stage 7 (food / live location) and is
 *     intentionally NOT registered now — adding it later is purely additive
 *     (register one renderer, change nothing else).
 *   - An unknown mode → graceful `UnsupportedTracking` fallback, never a crash
 *     (forward-compat).
 *
 * `capabilities.liveLocation` (false for retail) is what a future `map` renderer
 * would consult to open the geo channel; Stage 1 never opens one.
 */

type TrackingRendererFn = (props: { order: Order }) => ReactElement;

const trackingRegistry = new Map<string, TrackingRendererFn>();

/** Register a renderer for a `trackingMode`. Exported for Stage 7's `map` add. */
export function registerTracking(mode: string, r: TrackingRendererFn): void {
  trackingRegistry.set(mode, r);
}

/** Test/introspection helper — the set of registered modes. */
export function registeredTrackingModes(): string[] {
  return [...trackingRegistry.keys()];
}

// Stage 1: ONLY 'timeline' is registered.
registerTracking("timeline", TimelineRenderer);
// 'map' slot RESERVED for Stage 7 — intentionally NOT registered:
// registerTracking('map', MapRenderer);

function UnsupportedTracking({ mode }: { mode: string }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
      Live tracking for mode <code>{mode}</code> isn&apos;t available in this
      build.
    </div>
  );
}

/** Dispatch to the registered renderer for `order.display.trackingMode`. */
export function TrackingRenderer({ order }: { order: Order }) {
  const r = trackingRegistry.get(order.display.trackingMode);
  if (!r) return <UnsupportedTracking mode={order.display.trackingMode} />;
  return r({ order });
}
