import { Module } from "@nestjs/common";

import { CanonicalizerService } from "./canonicalizer.service";
import { GridPolicyService } from "./grid-policy.service";

/**
 * SearchSupportModule — the pure, dependency-light search helpers (canonicalizer +
 * grid policy) shared by both Search and the GenerationGateway. Splitting these
 * out breaks the Search→Generation→canonicalizer import cycle: both feature
 * modules import this leaf module instead of each other for the shared bits.
 */
@Module({
  providers: [CanonicalizerService, GridPolicyService],
  exports: [CanonicalizerService, GridPolicyService],
})
export class SearchSupportModule {}
