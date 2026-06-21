import { type SearchResult } from "@dopamine/contracts";
import { Controller, Get, Query } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";

import { CatalogService } from "../catalog/catalog.service";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../identity/current-user.decorator";
import { type AuthPrincipal } from "../identity/identity.service";

import { SearchQuerySchema, SearchResultDto, type SearchQuery } from "./search.dto";
import { SearchService } from "./search.service";

/**
 * Search controller (doc 01 §7). `GET /v1/search?q=&storefrontId=` returns the
 * blended grid + a `generation` hint on a miss; never blocks. Protected by the
 * global DeviceAuthGuard — `deviceId` (for the generation request) comes from the
 * authenticated principal.
 */
@ApiTags("search")
@Controller({ version: "1" })
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly catalog: CatalogService,
  ) {}

  @Get("search")
  @ApiOperation({ summary: "Search the catalog; returns a blended grid + a generation hint on a miss" })
  @ApiQuery({ name: "q", required: true })
  @ApiQuery({ name: "storefrontId", required: false })
  @ApiOkResponse({ type: SearchResultDto })
  async doSearch(
    // Param-level pipe so ONLY the query object is validated (a method-level
    // @UsePipes would also run against @CurrentUser, which has no `q`).
    @Query(new ZodValidationPipe(SearchQuerySchema)) query: SearchQuery,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<SearchResult> {
    const storefront = await this.catalog.resolveStorefront(query.storefrontId ?? null);
    return this.search.search(query.q, {
      storefrontId: storefront.id,
      verticalId: storefront.verticalId,
      deviceId: user.deviceId,
    });
  }
}
