import { describe, expect, it, vi } from "vitest";

import { type EventBus } from "../events/event-bus.service";
import { type PrismaService } from "../prisma/prisma.service";

import { CatalogService, type GeneratedListingInput } from "./catalog.service";

/**
 * The generated-listing write-back is transactional + idempotent (doc 01 §4.4).
 * For the dedup ANCHOR it must `upsert` on the `(storefrontId, canonicalQuery)`
 * unique key so a retried job is a no-op. For a FILLER it `create`s a distinct row
 * with a null canonicalQuery (so the unique constraint isn't violated by a grid).
 */
function baseInput(overrides: Partial<GeneratedListingInput> = {}): GeneratedListingInput {
  return {
    storefrontId: "sto_1",
    verticalId: "retail",
    canonicalQuery: "ladder",
    generationId: "gen_BATCH",
    fields: { title: "A Ladder", description: "desc", priceCents: 8900, currency: "USD", attributes: {} },
    media: {
      status: "generating_media",
      hero: { url: "http://minio/h.svg", kind: "image", blurhash: null, aspect_ratio: 1 },
      alternates: [],
      expected_ready_ms: 1500,
      generation_id: "gen_BATCH",
    },
    imageUrls: ["http://minio/h.svg"],
    isAnchor: true,
    ...overrides,
  };
}

function makeMocks(persistedRow: Record<string, unknown>) {
  const calls = { upsert: [] as unknown[], create: [] as unknown[] };
  const tx = {
    listing: {
      upsert: vi.fn((args: unknown) => {
        calls.upsert.push(args);
        return Promise.resolve(persistedRow);
      }),
      create: vi.fn((args: unknown) => {
        calls.create.push(args);
        return Promise.resolve(persistedRow);
      }),
    },
    outboxEvent: { create: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const publishTxCalls: { tx: unknown; event: unknown }[] = [];
  const eventBus = {
    publishTx: vi.fn((t: unknown, event: unknown) => {
      publishTxCalls.push({ tx: t, event });
      return Promise.resolve(undefined);
    }),
  } as unknown as EventBus;
  return { prisma, eventBus, calls, tx, publishTxCalls };
}

const persistedRow = {
  id: "lst_1",
  storefrontId: "sto_1",
  verticalId: "retail",
  categoryId: null,
  title: "A Ladder",
  description: "desc",
  priceCents: 8900,
  currency: "USD",
  attributes: {},
  media: {
    status: "generating_media",
    hero: { url: "http://minio/h.svg", kind: "image", blurhash: null, aspect_ratio: 1 },
    alternates: [],
    expected_ready_ms: 1500,
    generation_id: "gen_BATCH",
  },
  imageUrls: ["http://minio/h.svg"],
  origin: "generated",
  status: "placeholder",
  canonicalQuery: "ladder",
  generationId: "gen_BATCH",
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("CatalogService.writeBackGenerated", () => {
  it("anchor → upserts on the (storefrontId, canonicalQuery) idempotency key", async () => {
    const m = makeMocks(persistedRow);
    const svc = new CatalogService(m.prisma, m.eventBus);

    const out = await svc.writeBackGenerated(baseInput());

    expect(out.id).toBe("lst_1");
    expect(m.calls.upsert).toHaveLength(1);
    const upsert = m.calls.upsert[0] as { where: { storefrontId_canonicalQuery: { storefrontId: string; canonicalQuery: string } } };
    expect(upsert.where.storefrontId_canonicalQuery).toEqual({ storefrontId: "sto_1", canonicalQuery: "ladder" });

    // The outbox event must be published on the SAME tx as the listing write so
    // they commit atomically (no dual-write window). Exactly one publishTx call,
    // carrying the same transaction client the listing was written on.
    expect(m.publishTxCalls).toHaveLength(1);
    expect(m.publishTxCalls[0]?.tx).toBe(m.tx);
    expect(m.publishTxCalls[0]?.event).toMatchObject({
      type: "listing.generated",
      listingId: "lst_1",
      storefrontId: "sto_1",
      canonicalQuery: "ladder",
    });
    // Single $transaction → listing + outbox row share one commit.
    expect((m.prisma.$transaction as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it("filler → creates a distinct row with a null canonicalQuery (no unique clash)", async () => {
    const m = makeMocks({ ...persistedRow, canonicalQuery: null });
    const svc = new CatalogService(m.prisma, m.eventBus);

    await svc.writeBackGenerated(baseInput({ isAnchor: false }));

    expect(m.calls.create).toHaveLength(1);
    const create = m.calls.create[0] as { data: { canonicalQuery: string | null } };
    expect(create.data.canonicalQuery).toBeNull();
  });
});
