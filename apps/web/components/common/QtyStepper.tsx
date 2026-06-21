"use client";

/**
 * Accessible quantity stepper. Real buttons + an aria-labelled live value (this
 * is the functional a11y baseline, not the Stage-3 a11y pass). Decrementing below
 * 1 is the caller's concern (cart maps qty 0 → remove via DELETE).
 */
export function QtyStepper({
  qty,
  onChange,
  min = 1,
  disabled = false,
  label = "Quantity",
}: {
  qty: number;
  onChange: (next: number) => void;
  min?: number;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-neutral-300">
      <button
        type="button"
        className="px-3 py-1 text-lg leading-none disabled:opacity-40"
        onClick={() => onChange(qty - 1)}
        disabled={disabled || qty <= min}
        aria-label={`Decrease ${label.toLowerCase()}`}
      >
        −
      </button>
      <span
        className="min-w-8 select-none text-center text-sm tabular-nums"
        aria-label={label}
        aria-live="polite"
      >
        {qty}
      </span>
      <button
        type="button"
        className="px-3 py-1 text-lg leading-none disabled:opacity-40"
        onClick={() => onChange(qty + 1)}
        disabled={disabled}
        aria-label={`Increase ${label.toLowerCase()}`}
      >
        +
      </button>
    </div>
  );
}
