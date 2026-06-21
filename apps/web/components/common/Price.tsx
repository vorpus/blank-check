import { type Money } from "@dopamine/contracts";

import { formatMoney } from "@/lib/money";

/** Render a `Money` amount. Formatting is client-side (doc 05 §6.1). */
export function Price({
  amount,
  className,
}: {
  amount: Money;
  className?: string;
}) {
  return <span className={className}>{formatMoney(amount)}</span>;
}
