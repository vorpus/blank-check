import { describe, expect, it, vi } from "vitest";

import { type CatalogService } from "../catalog/catalog.service";
import { type EventBus } from "../events/event-bus.service";
import { type PrismaService } from "../prisma/prisma.service";
import { type GenerationEnrichJob } from "../queue/queue.constants";
import { type StorageService } from "../storage/storage.service";

import { EnrichService, MediaNotReadyError } from "./enrich.service";
import { type FakeGenClient, type MediaPollResponse } from "./fake-gen.client";

/**
 * The enrich processor (charter §5.5.2) — the worker-driven async media swap.
 * These tests pin its two load-bearing behaviors: (1) a still-rendering poll
 * throws so BullMQ retries; (2) a ready poll ingests final bytes to MinIO,
 * flips listing media → ready, and writes an images.ready outbox event — all in
 * one transaction, idempotently.
 */

function finalMedia(genId: string, status: "ready" | "degraded" = "ready") {
  return {
    status,
    hero: {
      url: `http://fake-gen:8090/img/fin/${genId}.svg`,
      kind: "image" as const,
      blurhash: null,
      aspect_ratio: 1,
    },
    alternates: [],
    expected_ready_ms: null,
    generation_id: genId,
  };
}

interface Mocks {
  prisma: PrismaService;
  fakeGen: FakeGenClient;
  storage: StorageService;
  catalog: CatalogService;
  eventBus: EventBus;
  txCalls: { listingUpdates: unknown[]; outbox: unknown[]; inboxCreated: string[] };
}

function makeMocks(poll: MediaPollResponse): Mocks {
  const txCalls = { listingUpdates: [] as unknown[], outbox: [] as unknown[], inboxCreated: [] as string[] };

  const tx = {
    inboxEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn((args: { data: { id: string } }) => {
        txCalls.inboxCreated.push(args.data.id);
        return Promise.resolve(args.data);
      }),
    },
    listing: {
      update: vi.fn((args: unknown) => {
        txCalls.listingUpdates.push(args);
        return Promise.resolve({});
      }),
    },
    outboxEvent: { create: vi.fn() },
  };

  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;

  const fakeGen = { pollMedia: vi.fn().mockResolvedValue(poll) } as unknown as FakeGenClient;

  const storage = {
    ingestFromUrl: vi.fn((url: string) =>
      Promise.resolve({ key: "gen/ab/abc.svg", url: url.replace("fake-gen:8090", "minio:9000/listing-images") }),
    ),
  } as unknown as StorageService;

  const catalog = {} as CatalogService;

  const eventBus = {
    publishTx: vi.fn((_t: unknown, e: unknown) => {
      txCalls.outbox.push(e);
      return Promise.resolve();
    }),
  } as unknown as EventBus;

  return { prisma, fakeGen, storage, catalog, eventBus, txCalls };
}

const job: GenerationEnrichJob = {
  jobId: "req_1",
  generationId: "gen_BATCH",
  storefrontId: "sto_1",
  verticalId: "retail",
  canonicalQuery: "ladder",
  listingIds: ["lst_1"],
};

describe("EnrichService", () => {
  it("throws MediaNotReadyError while still generating → triggers a BullMQ retry", async () => {
    const m = makeMocks({ generation_id: "gen_BATCH", outcome: "generating_media", items: [] });
    const svc = new EnrichService(m.prisma, m.fakeGen, m.storage, m.catalog, m.eventBus);
    await expect(svc.enrich(job)).rejects.toBeInstanceOf(MediaNotReadyError);
  });

  it("on ready: ingests final bytes to MinIO, flips media → ready, emits images.ready", async () => {
    const m = makeMocks({
      generation_id: "gen_BATCH",
      outcome: "ready",
      items: [{ generation_id: "gen_BATCH:g0", client_ref: "g0", media: finalMedia("gen_BATCH:g0") }],
    });
    const svc = new EnrichService(m.prisma, m.fakeGen, m.storage, m.catalog, m.eventBus);

    const result = await svc.enrich(job);

    expect(result).toEqual({ outcome: "ready", flipped: 1 });
    // Ingested the final hero to MinIO.
    expect(m.storage.ingestFromUrl).toHaveBeenCalledWith("http://fake-gen:8090/img/fin/gen_BATCH:g0.svg");
    // Flipped the listing to ready with the MinIO url.
    const update = m.txCalls.listingUpdates[0] as { where: { id: string }; data: { status: string; media: { hero: { url: string } } } };
    expect(update.where.id).toBe("lst_1");
    expect(update.data.status).toBe("ready");
    expect(update.data.media.hero.url).toContain("minio:9000/listing-images");
    // Wrote an images.ready outbox event (same txn).
    expect(m.txCalls.outbox).toHaveLength(1);
    expect((m.txCalls.outbox[0] as { type: string }).type).toBe("images.ready");
  });

  it("on degraded: flips media → degraded and emits images.degraded", async () => {
    const m = makeMocks({
      generation_id: "gen_BATCH",
      outcome: "degraded",
      items: [{ generation_id: "gen_BATCH:g0", client_ref: "g0", media: finalMedia("gen_BATCH:g0", "degraded") }],
    });
    const svc = new EnrichService(m.prisma, m.fakeGen, m.storage, m.catalog, m.eventBus);

    const result = await svc.enrich(job);
    expect(result.outcome).toBe("degraded");
    expect((m.txCalls.outbox[0] as { type: string }).type).toBe("images.degraded");
  });
});
