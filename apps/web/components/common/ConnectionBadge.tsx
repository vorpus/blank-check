import { type TrackingMode } from "@/hooks/useTracking";

/**
 * Reflects the live tracking transport (doc 03 §7.3): `live` (SSE) vs `polling`
 * (SSE dropped → `GET /v1/orders/{id}` fallback keeps the timeline current).
 */
export function ConnectionBadge({ mode }: { mode: TrackingMode }) {
  const live = mode === "live";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        live ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"
      }`}
      role="status"
    >
      <span
        className={`h-2 w-2 rounded-full ${live ? "bg-green-500" : "bg-amber-500"}`}
        aria-hidden="true"
      />
      {live ? "Live" : "Polling"}
    </span>
  );
}
