import { type DisplayStage, type TrackingMode } from "@dopamine/contracts";

/**
 * The Vertical abstraction (doc 01 §2.1, charter §1). A vertical bundles its
 * order state machine (config-as-data), its fulfillment strategy (plan timings),
 * its tracking provider (display projection), and its catalog policy. The core
 * (orders/search/catalog) consumes verticals ONLY through the registry — there is
 * never an `if (vertical === 'retail')` branch anywhere. Stage 1 registers retail
 * only; adding food in Stage 7 is a new registration, not a core change.
 */

/** XState v5 config-as-data: a state graph stored + versioned, not hand-coded. */
export interface OrderMachineConfig {
  id: string; // "retail.v1"
  initial: string;
  states: Record<string, OrderMachineState>;
}

export interface OrderMachineState {
  /** event name → target state. Absent for terminal states. */
  on?: Record<string, string>;
  type?: "final";
}

/** One ordered fulfillment step with an accelerated delay (doc 01 §10). */
export interface PlanStep {
  state: string;
  event: string;
  delayMs: number;
  terminal?: boolean;
}

/** The minimal order shape a strategy needs to build a plan (avoids a Prisma dep). */
export interface OrderLike {
  id: string;
  verticalId: string;
  state: string;
}

/** Builds the ordered fulfillment plan for an order (timings are config). */
export interface FulfillmentStrategy {
  buildPlan(order: OrderLike): PlanStep[];
}

/** Projects an order's live state onto the vertical-agnostic display block. */
export interface TrackingProvider {
  trackingMode: TrackingMode;
  liveLocation: boolean;
  /** Human label for a state key (used on TrackingEvent + display stages). */
  labelFor(state: string): string;
  /** The ordered, server-defined lifecycle stages marked against `currentState`. */
  stagesFor(currentState: string): DisplayStage[];
}

export interface CatalogPolicy {
  generationEnabled: boolean;
  attributeSchema: Record<string, unknown>;
}

export interface Vertical {
  id: string; // "retail"
  displayName: string;
  stateMachineKey: string; // "retail.v1"
  stateMachine: OrderMachineConfig;
  fulfillment: FulfillmentStrategy;
  tracking: TrackingProvider;
  catalogPolicy: CatalogPolicy;
}
