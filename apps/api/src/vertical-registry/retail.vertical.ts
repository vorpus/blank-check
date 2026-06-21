import { type DisplayStage } from "@dopamine/contracts";
import { Injectable } from "@nestjs/common";

import {
  type CatalogPolicy,
  type FulfillmentStrategy,
  type OrderLike,
  type OrderMachineConfig,
  type PlanStep,
  type TrackingProvider,
  type Vertical,
} from "./vertical.types";

/**
 * The retail vertical (doc 01 §9–§10, charter §5.5.3). The ONLY vertical
 * registered in Stage 1, but it is a full first-class `Vertical` — state machine
 * as data, fulfillment timings as config, tracking projection as a provider. The
 * core consumes it through the registry; nothing branches on "retail".
 *
 * State spelling is the frozen doc-04 set (charter §5.5.3):
 *   placed/confirmed → packed → shipped → out_for_delivery → delivered (+ cancelled).
 * Stage 1 initial state is `confirmed` (the order is confirmed at place time).
 */

const RETAIL_MACHINE: OrderMachineConfig = {
  id: "retail.v1",
  initial: "confirmed",
  states: {
    confirmed: { on: { dispatch_packing: "packed", cancel: "cancelled" } },
    packed: { on: { ship: "shipped", cancel: "cancelled" } },
    shipped: { on: { arrive_local: "out_for_delivery" } },
    out_for_delivery: { on: { deliver: "delivered" } },
    delivered: { type: "final" },
    cancelled: { type: "final" },
  },
};

const STATE_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  packed: "Packed",
  shipped: "Shipped",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

// The visible timeline (cancelled is an escape, not a timeline stage).
const TIMELINE_STATES = ["confirmed", "packed", "shipped", "out_for_delivery", "delivered"] as const;

// Hours of "real" retail time per step; the worker compresses these via TIME_SCALE
// at plan-build time (doc 01 §10). Timings as config, not code.
const STEP_HOURS: Record<string, { event: string; hours: number; terminal?: boolean }> = {
  packed: { event: "dispatch_packing", hours: 2 },
  shipped: { event: "ship", hours: 6 },
  out_for_delivery: { event: "arrive_local", hours: 28 },
  delivered: { event: "deliver", hours: 3, terminal: true },
};

class RetailFulfillment implements FulfillmentStrategy {
  // TIME_SCALE is applied by the worker at runtime (it owns the env); the strategy
  // emits the canonical "hours" and the worker scales. Stage 1 keeps a sane default
  // so a plan built outside the worker is still ordered + finite.
  constructor(private readonly timeScale = 3600) {}

  buildPlan(_order: OrderLike): PlanStep[] {
    const hours = (h: number): number => Math.max(1, Math.round((h * 3_600_000) / this.timeScale));
    return TIMELINE_STATES.filter((s) => s !== "confirmed").map((state) => {
      const def = STEP_HOURS[state];
      if (!def) throw new Error(`no step config for retail state ${state}`);
      return { state, event: def.event, delayMs: hours(def.hours), terminal: def.terminal };
    });
  }
}

class RetailTracking implements TrackingProvider {
  readonly trackingMode = "timeline" as const;
  readonly liveLocation = false;

  labelFor(state: string): string {
    return STATE_LABELS[state] ?? state;
  }

  stagesFor(currentState: string): DisplayStage[] {
    const currentIdx = TIMELINE_STATES.indexOf(currentState as (typeof TIMELINE_STATES)[number]);
    return TIMELINE_STATES.map((state, idx) => ({
      key: state,
      label: this.labelFor(state),
      // If the order was cancelled, nothing past `confirmed` is "reached".
      reached: currentIdx >= 0 ? idx <= currentIdx : idx === 0,
      current: idx === currentIdx,
    }));
  }
}

/**
 * RetailVertical — registered into the VerticalRegistry via the VERTICAL multi-token.
 */
@Injectable()
export class RetailVertical implements Vertical {
  readonly id = "retail";
  readonly displayName = "Retail";
  readonly stateMachineKey = "retail.v1";
  readonly stateMachine = RETAIL_MACHINE;
  readonly fulfillment: FulfillmentStrategy = new RetailFulfillment();
  readonly tracking: TrackingProvider = new RetailTracking();
  readonly catalogPolicy: CatalogPolicy = {
    generationEnabled: true,
    attributeSchema: {
      brand: "string",
      material: "string",
      style: "string",
    },
  };
}
