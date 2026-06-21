import { Module } from "@nestjs/common";

import { CatalogController } from "./catalog.controller";
import { CatalogService } from "./catalog.service";

/**
 * CatalogModule (doc 01 §2). Owns storefronts/categories/listings. Exports
 * CatalogService so the generation gateway (write-back) and search (read) consume
 * it through the provider interface, never by touching catalog tables directly.
 */
@Module({
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
