import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";

import { CatalogService } from "../catalog/catalog.service";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../identity/current-user.decorator";
import { type AuthPrincipal } from "../identity/identity.service";

import {
  AddCartItemDto,
  CartQuerySchema,
  CartViewDto,
  UpdateCartItemDto,
  type CartQuery,
  type CartView,
} from "./cart.dto";
import { CartService } from "./cart.service";

/**
 * Cart controller (doc 01 §7). The one active cart per (device-user, storefront);
 * the storefront is resolved (default to Mega-Mart if omitted). Every response is
 * the recomputed CartView with the `version` cursor for optimistic concurrency.
 * Protected by the global DeviceAuthGuard — the userId comes from the principal.
 */
@ApiTags("cart")
@Controller({ version: "1" })
export class CartController {
  constructor(
    private readonly cart: CartService,
    private readonly catalog: CatalogService,
  ) {}

  @Get("cart")
  @ApiOperation({ summary: "Get (or create) the active cart for the device user + storefront" })
  @ApiQuery({ name: "storefrontId", required: false })
  @ApiOkResponse({ type: CartViewDto })
  async getCart(
    @Query(new ZodValidationPipe(CartQuerySchema)) query: CartQuery,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<CartView> {
    const storefront = await this.catalog.resolveStorefront(query.storefrontId ?? null);
    return this.cart.getOrCreate(user.userId, storefront.id);
  }

  @Post("cart/items")
  @ApiOperation({ summary: "Add a listing to the cart; recomputes totals" })
  @ApiOkResponse({ type: CartViewDto })
  async addItem(
    @Body() body: AddCartItemDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<CartView> {
    const storefront = await this.catalog.resolveStorefront(body.storefrontId ?? null);
    return this.cart.addItem(user.userId, storefront.id, {
      listingId: body.listingId,
      qty: body.qty,
      version: body.version,
    });
  }

  @Patch("cart/items/:id")
  @ApiOperation({ summary: "Change a cart item's quantity (optimistic version check)" })
  @ApiOkResponse({ type: CartViewDto })
  async updateItem(
    @Param("id") id: string,
    @Body() body: UpdateCartItemDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<CartView> {
    const storefront = await this.catalog.resolveStorefront(null);
    return this.cart.updateItem(user.userId, storefront.id, id, {
      qty: body.qty,
      version: body.version,
    });
  }

  @Delete("cart/items/:id")
  @ApiOperation({ summary: "Remove a cart item; recomputes totals" })
  @ApiOkResponse({ type: CartViewDto })
  async removeItem(
    @Param("id") id: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<CartView> {
    const storefront = await this.catalog.resolveStorefront(null);
    return this.cart.removeItem(user.userId, storefront.id, id);
  }
}
