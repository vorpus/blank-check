import { describe, expect, it, vi } from "vitest";

import { ConflictError } from "../common/errors";
import { type PrismaService } from "../prisma/prisma.service";

import { CartService } from "./cart.service";

/**
 * CartService (doc 01 §1, §8.2). These pin the two load-bearing behaviors:
 *   1. totals recompute in integer cents (unitPrice * qty, summed).
 *   2. optimistic concurrency — a stale expected `version` is a 409 conflict.
 */

interface FakeCart {
  id: string;
  userId: string;
  storefrontId: string;
  status: string;
  version: number;
  updatedAt: Date;
}

/** A minimal in-memory Prisma double covering the cart read/mutate paths. */
function makeMocks(opts: { version: number; items: { id: string; listingId: string; qty: number; unitPriceCents: number; title: string; currency: string }[] }) {
  const cart: FakeCart = {
    id: "crt_1",
    userId: "usr_1",
    storefrontId: "sto_1",
    status: "active",
    version: opts.version,
    updatedAt: new Date("2026-06-21T00:00:00.000Z"),
  };
  const items = opts.items;

  const tx = {
    cart: {
      updateMany: vi.fn((args: { where: { version: number }; data: { version: number } }) => {
        if (args.where.version !== cart.version) return Promise.resolve({ count: 0 });
        cart.version = args.data.version;
        return Promise.resolve({ count: 1 });
      }),
    },
    cartItem: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };

  const prisma = {
    cart: {
      findFirst: vi.fn().mockResolvedValue({ id: cart.id, version: cart.version }),
      findUnique: vi.fn(() =>
        Promise.resolve({
          ...cart, // read the LIVE cart (version reflects the in-tx bump)
          items: items.map((it) => ({
            id: it.id,
            listingId: it.listingId,
            qty: it.qty,
            unitPriceCents: it.unitPriceCents,
            listing: { title: it.title, currency: it.currency },
          })),
        }),
      ),
      create: vi.fn(),
    },
    listing: {
      findUnique: vi.fn().mockResolvedValue({ id: "lst_1", storefrontId: "sto_1", priceCents: 8900, currency: "USD" }),
    },
    $transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;

  return { prisma, cart };
}

describe("CartService", () => {
  it("recomputes totals in integer cents (unitPrice * qty, summed)", async () => {
    const m = makeMocks({
      version: 0,
      items: [
        { id: "cit_1", listingId: "lst_1", qty: 2, unitPriceCents: 8900, title: "Ladder", currency: "USD" },
        { id: "cit_2", listingId: "lst_2", qty: 3, unitPriceCents: 1899, title: "Hammer", currency: "USD" },
      ],
    });
    const svc = new CartService(m.prisma);

    const view = await svc.addItem("usr_1", "sto_1", { listingId: "lst_1", qty: 1 });

    // 8900*2 + 1899*3 = 17800 + 5697 = 23497
    expect(view.subtotal.amount_cents).toBe(23497);
    expect(view.subtotal.currency).toBe("USD");
    expect(view.items[0]?.lineTotal.amount_cents).toBe(17800);
    expect(view.items[1]?.lineTotal.amount_cents).toBe(5697);
    expect(view.version).toBe(1); // bumped
  });

  it("rejects a stale expected version with a 409 conflict (optimistic concurrency)", async () => {
    const m = makeMocks({ version: 5, items: [] });
    const svc = new CartService(m.prisma);

    // Caller thinks version is 2, but it's 5 → conflict.
    await expect(
      svc.addItem("usr_1", "sto_1", { listingId: "lst_1", qty: 1, version: 2 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
