import { Inject, Injectable } from "@nestjs/common";

import { UnknownVerticalError } from "../common/errors";

import { type Vertical } from "./vertical.types";

/** Multi-provider token: every registered Vertical is injected under this. */
export const VERTICAL = Symbol("VERTICAL");

/**
 * VerticalRegistry (doc 01 §2.1) — DI is what makes the registry first-class. All
 * registered verticals are injected via the VERTICAL multi-token and indexed by
 * id. `get` is the ONLY way the core reaches a vertical's machine/strategy/tracking
 * — so there is exactly one place that knows the set of verticals, and zero
 * `if (vertical === …)` branches in orders/search/catalog.
 */
@Injectable()
export class VerticalRegistry {
  private readonly byId = new Map<string, Vertical>();

  constructor(@Inject(VERTICAL) verticals: Vertical[]) {
    for (const v of verticals) this.byId.set(v.id, v);
  }

  get(verticalId: string): Vertical {
    const v = this.byId.get(verticalId);
    if (!v) throw new UnknownVerticalError(verticalId);
    return v;
  }

  has(verticalId: string): boolean {
    return this.byId.has(verticalId);
  }

  list(): Vertical[] {
    return [...this.byId.values()];
  }
}
