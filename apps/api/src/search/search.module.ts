import { Module } from "@nestjs/common";

import { CatalogModule } from "../catalog/catalog.module";
import { GenerationGatewayModule } from "../generation/generation.module";

import { SearchSupportModule } from "./search-support.module";
import { SearchController } from "./search.controller";
import { SearchService } from "./search.service";

/**
 * SearchModule (doc 01 §2.1). Wires the search→miss→generate→persist seam. Imports
 * Catalog (read), GenerationGateway (miss → generate), and SearchSupport (the
 * canonicalizer + grid policy, shared with the gateway to avoid a cycle).
 */
@Module({
  imports: [CatalogModule, GenerationGatewayModule, SearchSupportModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
