import { type Order } from "@dopamine/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  registeredTrackingModes,
  TrackingRenderer,
} from "./registry";

/**
 * The data-driven tracking contract (doc 03 §5, charter §6.5):
 *   - the registry resolves `timeline` and renders stages FROM `display.stages`,
 *   - `map` is reserved/unregistered (Stage 7) → graceful fallback, not a crash,
 *   - there is no hardcoded order-state list anywhere in the renderer path.
 */

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "ord_1",
    verticalId: "retail",
    storefrontId: "sto_1",
    state: "shipped",
    items: [],
    total: { amount_cents: 0, currency: "USD" },
    display: {
      trackingMode: "timeline",
      stages: [
        { key: "placed", label: "Placed", reached: true, current: false },
        { key: "packed", label: "Packed", reached: true, current: false },
        { key: "shipped", label: "Shipped", reached: true, current: true },
        { key: "delivered", label: "Delivered", reached: false, current: false },
      ],
    },
    capabilities: { liveLocation: false },
    streamUrl: "/v1/orders/ord_1/stream",
    placedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("TrackingRenderer registry", () => {
  it("registers ONLY timeline in Stage 1 (map slot reserved)", () => {
    const modes = registeredTrackingModes();
    expect(modes).toContain("timeline");
    expect(modes).not.toContain("map");
    expect(modes).toHaveLength(1);
  });

  it("resolves timeline and renders every stage label from display.stages", () => {
    render(<TrackingRenderer order={makeOrder()} />);
    expect(screen.getByText("Placed")).toBeInTheDocument();
    expect(screen.getByText("Packed")).toBeInTheDocument();
    expect(screen.getByText("Shipped")).toBeInTheDocument();
    expect(screen.getByText("Delivered")).toBeInTheDocument();
  });

  it("renders an ARBITRARY server-defined stage with zero client change", () => {
    // A stage key the client has never heard of — proves no hardcoded enum.
    const order = makeOrder({
      display: {
        trackingMode: "timeline",
        stages: [
          { key: "quantum_entangled", label: "Quantum entangled", reached: true, current: true },
        ],
      },
    });
    render(<TrackingRenderer order={order} />);
    expect(screen.getByText("Quantum entangled")).toBeInTheDocument();
  });

  it("falls back gracefully for an unregistered mode (map → Stage 7)", () => {
    const order = makeOrder({
      display: { trackingMode: "map", stages: [] },
    });
    render(<TrackingRenderer order={order} />);
    // No crash; a forward-compat notice mentions the unsupported mode.
    expect(screen.getByText(/map/)).toBeInTheDocument();
  });
});
