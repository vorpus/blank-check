import { type OrderMachineConfig } from "./vertical.types";

/**
 * Generic, vertical-agnostic transition resolution over an XState-v5-style config
 * (doc 01 §9.1). Used by the Orders module in 3b — `resolveTransition` returns the
 * next state for a (state, event) pair, or null if the edge is illegal (→ 409).
 * No `if (vertical === …)` here: the machine is data, this is the interpreter.
 */
export function resolveTransition(
  machine: OrderMachineConfig,
  fromState: string,
  event: string,
): string | null {
  const state = machine.states[fromState];
  if (!state || !state.on) return null;
  return state.on[event] ?? null;
}

/** Ordered list of state keys in declaration order (used to build display stages). */
export function stateOrder(machine: OrderMachineConfig): string[] {
  return Object.keys(machine.states);
}

/** True if a state has no outgoing edges (terminal). */
export function isTerminal(machine: OrderMachineConfig, state: string): boolean {
  return machine.states[state]?.type === "final";
}
