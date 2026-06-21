import { Module } from "@nestjs/common";

import { CatalogModule } from "../catalog/catalog.module";

import { CartController } from "./cart.controller";
import { CartService } from "./cart.service";

/**
 * CartModule (doc 01 §2) — owns `carts` / `cart_items`. Depends on Catalog to
 * resolve the storefront + read live listing prices at add-time. Exports
 * CartService so the Orders module can snapshot the active cart at checkout.
 */
@Module({
  imports: [CatalogModule],
  providers: [CartService],
  controllers: [CartController],
  exports: [CartService],
})
export class CartModule {}
