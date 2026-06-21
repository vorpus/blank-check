import { ID_PREFIXES, formatId } from "@dopamine/contracts";
import { ulid } from "ulid";

/**
 * Server-side prefixed-ULID minting (doc 05 §6.2). The contracts package owns the
 * canonical prefixes + validators; this adds the handful of api-internal entities
 * the wire contracts don't model (category, fulfillment plan, generation job,
 * outbox event). `mintId("listing")` → `lst_<26-char ULID>`. Monotonic ULIDs keep
 * ids sortable by creation time.
 */
const PREFIXES = {
  ...ID_PREFIXES,
  category: "cat",
  fulfillmentPlan: "ful",
  generationJob: "gjb",
  outboxEvent: "evt",
} as const;

export type MintEntity = keyof typeof PREFIXES;

export function mintId(entity: MintEntity): string {
  return formatId(PREFIXES[entity], ulid());
}
