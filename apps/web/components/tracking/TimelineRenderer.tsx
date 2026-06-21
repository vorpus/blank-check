import { type Order } from "@dopamine/contracts";

/**
 * `TimelineRenderer` — the ONLY tracking renderer registered in Stage 1 (doc 03
 * §5.2). Maps over `order.display.stages[]` and renders each `{ key, label,
 * reached, current }`. There is NO `const RETAIL_STAGES = [...]` — add a stage
 * server-side and this UI shows it with zero client change. The choreographed
 * stage reveal/celebration is Stage 3 `[→S3]`.
 */
export function TimelineRenderer({ order }: { order: Order }) {
  const stages = order.display.stages;

  return (
    <ol className="space-y-0" aria-label="Order progress">
      {stages.map((stage, i) => {
        const isLast = i === stages.length - 1;
        return (
          <li key={stage.key} className="flex gap-3">
            {/* Marker + connector rail */}
            <div className="flex flex-col items-center">
              <span
                className={`grid h-6 w-6 place-items-center rounded-full border-2 text-xs ${
                  stage.current
                    ? "border-blue-600 bg-blue-600 text-white"
                    : stage.reached
                      ? "border-green-600 bg-green-600 text-white"
                      : "border-neutral-300 bg-white text-neutral-400"
                }`}
                aria-hidden="true"
              >
                {stage.reached && !stage.current ? "✓" : ""}
              </span>
              {!isLast && (
                <span
                  className={`w-0.5 flex-1 ${
                    stage.reached ? "bg-green-500" : "bg-neutral-200"
                  }`}
                  style={{ minHeight: "1.5rem" }}
                  aria-hidden="true"
                />
              )}
            </div>

            {/* Label */}
            <div className="pb-6 pt-0.5">
              <p
                className={`text-sm ${
                  stage.current
                    ? "font-semibold text-blue-700"
                    : stage.reached
                      ? "font-medium text-neutral-900"
                      : "text-neutral-400"
                }`}
              >
                {stage.label}
                {stage.current && (
                  <span className="ml-2 text-xs font-normal text-blue-600">
                    in progress
                  </span>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
