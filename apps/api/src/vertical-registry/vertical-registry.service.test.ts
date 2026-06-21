import { describe, expect, it } from "vitest";

import { UnknownVerticalError } from "../common/errors";

import { RetailVertical } from "./retail.vertical";
import { resolveTransition } from "./state-machine";
import { VerticalRegistry } from "./vertical-registry.service";

/**
 * The Vertical abstraction must be REAL (doc 01 §2.1, charter §1): the registry is
 * the only way to reach a vertical, an unknown id throws (never a silent branch),
 * and the retail machine + tracking projection are config-as-data the generic
 * interpreter drives.
 */
describe("VerticalRegistry", () => {
  const registry = new VerticalRegistry([new RetailVertical()]);

  it("resolves the registered retail vertical", () => {
    expect(registry.get("retail").id).toBe("retail");
    expect(registry.has("retail")).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });

  it("throws UnknownVerticalError for an unregistered id (no if-branch fallback)", () => {
    expect(() => registry.get("food")).toThrow(UnknownVerticalError);
  });

  it("retail machine drives legal transitions via the generic interpreter", () => {
    const machine = registry.get("retail").stateMachine;
    expect(resolveTransition(machine, "confirmed", "dispatch_packing")).toBe("packed");
    expect(resolveTransition(machine, "packed", "ship")).toBe("shipped");
    expect(resolveTransition(machine, "shipped", "arrive_local")).toBe("out_for_delivery");
    expect(resolveTransition(machine, "out_for_delivery", "deliver")).toBe("delivered");
  });

  it("rejects illegal transitions (cancel from shipped → null → 409 upstream)", () => {
    const machine = registry.get("retail").stateMachine;
    expect(resolveTransition(machine, "shipped", "cancel")).toBeNull();
    expect(resolveTransition(machine, "delivered", "deliver")).toBeNull();
  });

  it("tracking projects vertical-agnostic display stages with reached/current", () => {
    const tracking = registry.get("retail").tracking;
    expect(tracking.trackingMode).toBe("timeline");
    expect(tracking.liveLocation).toBe(false);
    const stages = tracking.stagesFor("shipped");
    const shipped = stages.find((s) => s.key === "shipped");
    expect(shipped?.current).toBe(true);
    expect(shipped?.reached).toBe(true);
    expect(stages.find((s) => s.key === "delivered")?.reached).toBe(false);
  });

  it("retail fulfillment plan is ordered, finite, and ends terminal", () => {
    const plan = registry.get("retail").fulfillment.buildPlan({ id: "ord_1", verticalId: "retail", state: "confirmed" });
    expect(plan.map((s) => s.state)).toEqual(["packed", "shipped", "out_for_delivery", "delivered"]);
    expect(plan.at(-1)?.terminal).toBe(true);
    expect(plan.every((s) => s.delayMs > 0)).toBe(true);
  });
});
