import { Injectable } from "@nestjs/common";
import { type Prisma } from "@prisma/client";

import { ConflictError, NotFoundError } from "../common/errors";
import { mintId } from "../common/ids";
import { PrismaService } from "../prisma/prisma.service";

import { type CartItemView, type CartView } from "./cart.dto";

/**
 * CartService (doc 01 §2) — owns `carts` / `cart_items`. One active cart per
 * (device-user, storefront) — enforced by the `carts_one_active` partial-unique
 * index (migration 0002). Items reference LIVE listings; the unit price is
 * snapshotted from the listing at add-time (doc 01 §1). Totals are recomputed in
 * integer cents on every mutation.
 *
 * Optimistic concurrency (doc 01 §8.2): every read returns the cart `version`;
 * every mutation accepts an optional expected `version` and bumps it inside the
 * same transaction. A stale `version` → 409 conflict, so two devices editing the
 * same anonymous cart can't silently clobber each other.
 */
@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  /** Get (or lazily create) the one active cart for (user, storefront). */
  async getOrCreate(userId: string, storefrontId: string): Promise<CartView> {
    const cart = await this.findActive(userId, storefrontId);
    if (cart) return this.view(cart.id);
    // Create-on-first-read. The partial-unique index makes a concurrent double
    // create collapse to one (the loser hits the unique violation → re-read).
    try {
      const created = await this.prisma.cart.create({
        data: { id: mintId("cart"), userId, storefrontId, status: "active", version: 0 },
      });
      return this.view(created.id);
    } catch {
      const existing = await this.findActive(userId, storefrontId);
      if (!existing) throw new ConflictError("could not create cart");
      return this.view(existing.id);
    }
  }

  /** Add a listing to the cart (or bump qty if already present). */
  async addItem(
    userId: string,
    storefrontId: string,
    input: { listingId: string; qty: number; version?: number },
  ): Promise<CartView> {
    const listing = await this.prisma.listing.findUnique({ where: { id: input.listingId } });
    if (!listing) throw new NotFoundError(`listing not found: ${input.listingId}`);
    if (listing.storefrontId !== storefrontId) {
      throw new ConflictError("listing belongs to a different storefront", {
        listingId: input.listingId,
      });
    }

    return this.mutate(userId, storefrontId, input.version, async (tx, cart) => {
      const existing = await tx.cartItem.findUnique({
        where: { cartId_listingId: { cartId: cart.id, listingId: input.listingId } },
      });
      if (existing) {
        await tx.cartItem.update({
          where: { id: existing.id },
          data: { qty: existing.qty + input.qty },
        });
      } else {
        await tx.cartItem.create({
          data: {
            id: mintId("cartItem"),
            cartId: cart.id,
            listingId: input.listingId,
            qty: input.qty,
            unitPriceCents: listing.priceCents,
          },
        });
      }
    });
  }

  /** Change an item's quantity (qty must be ≥ 1; 0 → use removeItem). */
  async updateItem(
    userId: string,
    storefrontId: string,
    itemId: string,
    input: { qty: number; version?: number },
  ): Promise<CartView> {
    return this.mutate(userId, storefrontId, input.version, async (tx, cart) => {
      const item = await tx.cartItem.findUnique({ where: { id: itemId } });
      if (!item || item.cartId !== cart.id) {
        throw new NotFoundError(`cart item not found: ${itemId}`);
      }
      await tx.cartItem.update({ where: { id: itemId }, data: { qty: input.qty } });
    });
  }

  /** Remove an item from the cart. */
  async removeItem(
    userId: string,
    storefrontId: string,
    itemId: string,
    version?: number,
  ): Promise<CartView> {
    return this.mutate(userId, storefrontId, version, async (tx, cart) => {
      const item = await tx.cartItem.findUnique({ where: { id: itemId } });
      if (!item || item.cartId !== cart.id) {
        throw new NotFoundError(`cart item not found: ${itemId}`);
      }
      await tx.cartItem.delete({ where: { id: itemId } });
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async findActive(
    userId: string,
    storefrontId: string,
  ): Promise<{ id: string; version: number } | null> {
    return this.prisma.cart.findFirst({
      where: { userId, storefrontId, status: "active" },
      select: { id: true, version: true },
    });
  }

  /**
   * Run a cart mutation inside one transaction with optimistic-concurrency:
   * resolve/create the active cart, optionally assert the expected `version`,
   * apply the change, then bump `version` (which also touches `updatedAt`). The
   * bump is the concurrency token — a stale expected version is a 409.
   */
  private async mutate(
    userId: string,
    storefrontId: string,
    expectedVersion: number | undefined,
    apply: (tx: Prisma.TransactionClient, cart: { id: string; version: number }) => Promise<void>,
  ): Promise<CartView> {
    let cart = await this.findActive(userId, storefrontId);
    if (!cart) {
      await this.getOrCreate(userId, storefrontId);
      cart = await this.findActive(userId, storefrontId);
    }
    if (!cart) throw new ConflictError("could not resolve active cart");
    const resolved = cart;

    const updatedId = await this.prisma.$transaction(async (tx) => {
      if (expectedVersion !== undefined && expectedVersion !== resolved.version) {
        throw new ConflictError("cart was modified by another request", {
          expectedVersion,
          actualVersion: resolved.version,
        });
      }
      await apply(tx, resolved);
      // Bump version atomically: the WHERE on the current version makes this the
      // compare-and-swap even without an explicit expectedVersion (a concurrent
      // tx that bumped first changes count → 0 → conflict).
      const bumped = await tx.cart.updateMany({
        where: { id: resolved.id, version: resolved.version },
        data: { version: resolved.version + 1 },
      });
      if (bumped.count === 0) {
        throw new ConflictError("cart was modified concurrently", { cartId: resolved.id });
      }
      return resolved.id;
    });

    return this.view(updatedId);
  }

  /** Build the recomputed CartView (integer-cents totals) from the DB. */
  private async view(cartId: string): Promise<CartView> {
    const cart = await this.prisma.cart.findUnique({
      where: { id: cartId },
      include: { items: { include: { listing: true }, orderBy: { id: "asc" } } },
    });
    if (!cart) throw new NotFoundError(`cart not found: ${cartId}`);

    const currency = cart.items[0]?.listing.currency ?? "USD";
    const items: CartItemView[] = cart.items.map((it) => {
      const lineCents = it.unitPriceCents * it.qty;
      return {
        id: it.id,
        listingId: it.listingId,
        title: it.listing.title,
        qty: it.qty,
        unitPrice: { amount_cents: it.unitPriceCents, currency: it.listing.currency },
        lineTotal: { amount_cents: lineCents, currency: it.listing.currency },
      };
    });
    const subtotalCents = items.reduce((sum, it) => sum + it.lineTotal.amount_cents, 0);

    return {
      id: cart.id,
      storefrontId: cart.storefrontId,
      status: cart.status,
      version: cart.version,
      items,
      subtotal: { amount_cents: subtotalCents, currency },
      currency,
      updatedAt: cart.updatedAt.toISOString(),
    };
  }
}
