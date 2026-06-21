import { type Listing, type SearchGeneration } from "@dopamine/contracts";

/** Input the search module hands the gateway on a miss (doc 01 §4.3). */
export interface GenerationRequestInput {
  storefrontId: string;
  verticalId: string;
  deviceId: string;
  rawQuery: string;
  canonicalQuery: string;
  /** How many cards to generate (from the blended-grid regime; doc 01 §5). */
  count: number;
  regime: "hot" | "warm" | "cold";
}

/** What the gateway returns: the freshly persisted cards + the client hint. */
export interface GenerationOutcome {
  listings: Listing[];
  generation: SearchGeneration;
}
