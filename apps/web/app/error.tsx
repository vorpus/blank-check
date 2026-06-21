"use client";

import { useEffect } from "react";

/**
 * Route error boundary (doc 03 §3). NOTE: `degraded` media is NOT an error and
 * never reaches here — that's a usable listing state rendered inline (doc 03 §6).
 * This boundary is for genuine failures (network down, boundary parse failure).
 *
 * We show the user a GENERIC message and never surface `error.message` (it can
 * carry internal detail / unsanitized strings — L3); the detail is logged to the
 * console for diagnostics, keyed by Next's `digest` when present.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the real detail for diagnostics; the UI stays generic.
    console.error("[error-boundary]", error.digest ?? "", error);
  }, [error]);

  return (
    <div className="grid place-items-center py-20 text-center">
      <div className="max-w-sm space-y-3">
        <p className="text-sm font-medium text-neutral-800">
          Something went wrong.
        </p>
        <p className="text-xs text-neutral-500">
          An unexpected error occurred. Please try again.
        </p>
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
