import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Env } from "../config/env";

import { StorageService } from "./storage.service";

/**
 * fetchBytes is the image-ingest seam (charter §5.5.2). It must be hardened before
 * any bytes reach MinIO: reject fetches to hosts outside the FAKEGEN_URL allowlist
 * (SSRF), reject non-image content-types, and cap the body size (MAX_IMAGE_BYTES).
 */

const FAKEGEN_HOST = "fake-gen:8090";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "test",
    PORT: 8080,
    CORS_ORIGIN: "http://localhost:3000",
    DATABASE_URL: "postgres://x",
    REDIS_URL: "redis://x",
    FAKEGEN_URL: `http://${FAKEGEN_HOST}`,
    S3_ENDPOINT: "http://minio:9000",
    S3_REGION: "us-east-1",
    S3_BUCKET: "listing-images",
    S3_ACCESS_KEY_ID: "key",
    S3_SECRET_ACCESS_KEY: "secret",
    S3_FORCE_PATH_STYLE: true,
    S3_PUBLIC_BASE_URL: "http://minio:9000/listing-images",
    MAX_IMAGE_BYTES: 1024,
    JWT_SECRET: "secret",
    JWT_TTL_SECONDS: 43200,
    TIME_SCALE: 3600,
    GRID_TARGET: 24,
    COLD_BATCH: 8,
    GEN_LOCK_TTL_MS: 30000,
    GEN_MAX_CONCURRENCY: 8,
    EXACT_CACHE_TTL_SEC: 3600,
    ...overrides,
  };
}

/** A Response stub: `body` is null so fetchBytes uses the buffered cap path. */
function imageResponse(bytes: Uint8Array, contentType = "image/svg+xml"): Response {
  return {
    ok: true,
    status: 200,
    body: null,
    headers: new Headers({ "content-type": contentType, "content-length": String(bytes.length) }),
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  } as unknown as Response;
}

describe("StorageService.fetchBytes (image-ingest hardening)", () => {
  let fetchSpy: ReturnType<typeof vi.fn<(input: string) => Promise<Response>>>;

  beforeEach(() => {
    fetchSpy = vi.fn<(input: string) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts an in-allowlist, image, under-cap fetch", async () => {
    const svc = new StorageService(makeEnv());
    fetchSpy.mockResolvedValue(imageResponse(new Uint8Array(10)));

    const out = await svc.fetchBytes(`http://${FAKEGEN_HOST}/img/ok.svg`);
    expect(out.contentType).toBe("image/svg+xml");
    expect(out.bytes.length).toBe(10);
  });

  it("rejects a disallowed host (SSRF guard)", async () => {
    const svc = new StorageService(makeEnv());
    fetchSpy.mockResolvedValue(imageResponse(new Uint8Array(10)));

    await expect(svc.fetchBytes("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /disallowed host/,
    );
    // Never even issued the network request.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-image content-type", async () => {
    const svc = new StorageService(makeEnv());
    fetchSpy.mockResolvedValue(imageResponse(new Uint8Array(10), "text/html"));

    await expect(svc.fetchBytes(`http://${FAKEGEN_HOST}/img/evil.html`)).rejects.toThrow(
      /non-image content-type/,
    );
  });

  it("rejects an oversize image (Content-Length over the cap)", async () => {
    const svc = new StorageService(makeEnv({ MAX_IMAGE_BYTES: 512 }));
    fetchSpy.mockResolvedValue(imageResponse(new Uint8Array(2048)));

    await expect(svc.fetchBytes(`http://${FAKEGEN_HOST}/img/huge.svg`)).rejects.toThrow(
      /exceeds max size/,
    );
  });

  it("enforces the cap on the body even when Content-Length is absent", async () => {
    const svc = new StorageService(makeEnv({ MAX_IMAGE_BYTES: 16 }));
    const big = new Uint8Array(64);
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
      headers: new Headers({ "content-type": "image/png" }), // no content-length
      arrayBuffer: () => Promise.resolve(big.buffer),
    } as unknown as Response);

    await expect(svc.fetchBytes(`http://${FAKEGEN_HOST}/img/lying.png`)).rejects.toThrow(
      /exceeds max size/,
    );
  });
});
