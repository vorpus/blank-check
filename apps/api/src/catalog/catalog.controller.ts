import { type Listing } from "@dopamine/contracts";
import { Controller, Get, Param } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { type Category, CategoryListResponseDto, ListingResponseDto } from "./catalog.dto";
import { CatalogService } from "./catalog.service";

/**
 * Catalog controller (doc 01 §7). Listing detail + the storefront category tree.
 * Read endpoints; protected by the global DeviceAuthGuard (a bearer is required).
 */
@ApiTags("catalog")
@Controller({ version: "1" })
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get("listings/:id")
  @ApiOperation({ summary: "Get a listing by id (attributes, media, imageUrls, status)" })
  @ApiOkResponse({ type: ListingResponseDto })
  getListing(@Param("id") id: string): Promise<Listing> {
    return this.catalog.getListing(id);
  }

  @Get("storefronts/:id/categories")
  @ApiOperation({ summary: "List a storefront's category tree" })
  @ApiOkResponse({ type: CategoryListResponseDto })
  categories(@Param("id") storefrontId: string): Promise<Category[]> {
    return this.catalog.listCategories(storefrontId);
  }
}
