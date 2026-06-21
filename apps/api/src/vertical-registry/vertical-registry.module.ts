import { Global, Module, type Provider } from "@nestjs/common";

import { RetailVertical } from "./retail.vertical";
import { VERTICAL, VerticalRegistry } from "./vertical-registry.service";
import { type Vertical } from "./vertical.types";

/**
 * VerticalRegistryModule (doc 01 §2.1). The set of registered verticals is bound
 * under the VERTICAL token as an array assembled by a factory from the individual
 * vertical providers. The registry injects that array and indexes it by id — so
 * `get()` is the only way the core reaches a vertical and there is zero
 * `if (vertical === …)` branching. Adding food in Stage 7 = add its provider class
 * here and into the factory's `inject`; nothing else changes. Global so
 * orders/search/catalog can inject the registry anywhere.
 */
const verticalsProvider: Provider = {
  provide: VERTICAL,
  useFactory: (retail: RetailVertical): Vertical[] => [retail],
  inject: [RetailVertical],
};

@Global()
@Module({
  providers: [RetailVertical, verticalsProvider, VerticalRegistry],
  exports: [VerticalRegistry],
})
export class VerticalRegistryModule {}
