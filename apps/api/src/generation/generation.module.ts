import { Module } from "@nestjs/common";

import { CatalogModule } from "../catalog/catalog.module";
import { SearchSupportModule } from "../search/search-support.module";

import { EnrichService } from "./enrich.service";
import { FakeGenClient } from "./fake-gen.client";
import { GenerationGateway } from "./generation-gateway.service";

/**
 * GenerationGatewayModule (doc 01 §2). Owns `generation_jobs` and the fake-gen
 * provider adapter. Depends on Catalog (write-back) and the search-support module
 * (the canonicalizer is shared with Search). Exports the gateway + client so the
 * search module and the worker enrich processor consume them.
 */
@Module({
  imports: [CatalogModule, SearchSupportModule],
  providers: [GenerationGateway, FakeGenClient, EnrichService],
  exports: [GenerationGateway, FakeGenClient, EnrichService],
})
export class GenerationGatewayModule {}
