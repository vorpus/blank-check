"use client";

import { type CartItem } from "@dopamine/contracts";

import { Price } from "@/components/common/Price";
import { QtyStepper } from "@/components/common/QtyStepper";

/**
 * One cart line (doc 03 §2.4). Quantity changes are optimistic in the parent
 * (`useCart`); decrementing to 0 maps to a remove (DELETE) rather than qty=0,
 * which the contract rejects.
 */
export function CartLineItem({
  item,
  onSetQty,
  onRemove,
  disabled = false,
}: {
  item: CartItem;
  onSetQty: (qty: number) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-4 py-4">
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium text-neutral-900">
          {item.title}
        </h3>
        <Price
          amount={item.unitPrice}
          className="text-xs text-neutral-500"
        />
        <span className="text-xs text-neutral-500"> each</span>
      </div>

      <QtyStepper
        qty={item.qty}
        disabled={disabled}
        // qty floor is 1; the explicit Remove button handles deletion.
        onChange={(next) => {
          if (next < 1) onRemove();
          else onSetQty(next);
        }}
      />

      <Price
        amount={item.lineTotal}
        className="w-20 text-right text-sm font-semibold text-neutral-900"
      />

      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        className="text-xs text-neutral-400 underline hover:text-red-600 disabled:opacity-40"
        aria-label={`Remove ${item.title} from cart`}
      >
        Remove
      </button>
    </div>
  );
}
