import { createHash } from "node:crypto";

import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Inject, Injectable } from "@nestjs/common";

import { StructuredLogger } from "../common/logger";
import { ENV } from "../config/config.module";
import { type Env } from "../config/env";

/** A fetched image to ingest: raw bytes + content type. */
export interface IngestInput {
  bytes: Uint8Array;
  contentType: string;
  /** Stable provider-side identity for the content-addressed key (e.g. fake-gen URL). */
  sourceKey: string;
}

/** The persisted result: the public URL the browser/SDK consumes. */
export interface IngestResult {
  key: string;
  url: string;
}

/**
 * StorageService — MinIO/S3 image ingestion (charter §5.5.2, doc 01 §4.4). The
 * BACKEND owns ingestion: a provider hands us fetchable bytes, we PUT them into
 * our bucket and persist OUR url — no provider ever writes our bucket.
 *
 * Keys are CONTENT-ADDRESSED (`sha256(sourceKey)` + extension), so re-ingesting
 * the same image is idempotent: same key, the HEAD short-circuits the PUT. This
 * is what makes the enrich processor safe to retry (DLQ redelivery → no dup blob).
 *
 * Stage 5 swap: only the four S3_* env values change (MinIO → R2 + CDN); this
 * code does not move (the AWS SDK speaks S3 to both).
 */
@Injectable()
export class StorageService {
  private readonly logger = new StructuredLogger("storage");
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;
  /** Hosts we're allowed to fetch image bytes from (SSRF guard). */
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly maxImageBytes: number;

  constructor(@Inject(ENV) env: Env) {
    this.bucket = env.S3_BUCKET;
    this.publicBaseUrl = env.S3_PUBLIC_BASE_URL.replace(/\/$/, "");
    this.maxImageBytes = env.MAX_IMAGE_BYTES;
    // Only fake-gen serves provider image bytes; derive the allowlist from its
    // configured URL so a malicious/poisoned provider url can't pivot us into an
    // internal-network fetch (SSRF).
    this.allowedHosts = new Set([new URL(env.FAKEGEN_URL).host]);
    this.s3 = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  /** Content-addressed object key for a source identity + content type. */
  contentAddressedKey(sourceKey: string, contentType: string): string {
    const digest = createHash("sha256").update(sourceKey).digest("hex");
    const ext = extensionFor(contentType);
    // Shard by the first two hex chars to keep bucket listings shallow.
    return `gen/${digest.slice(0, 2)}/${digest}${ext}`;
  }

  /**
   * Fetch bytes from a provider URL (fake-gen `/img/...`), hardened against SSRF +
   * resource abuse before anything is written to MinIO:
   *   (a) the URL host must be in the FAKEGEN_URL-derived allowlist;
   *   (b) the response Content-Type must be an image;
   *   (c) the body must not exceed MAX_IMAGE_BYTES (checked against the
   *       Content-Length header up front, then enforced while streaming since a
   *       header can lie or be absent).
   */
  async fetchBytes(url: string): Promise<IngestInput> {
    this.assertAllowedHost(url);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`failed to fetch image bytes from ${url}: HTTP ${String(res.status)}`);
    }

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    if (!isImageContentType(contentType)) {
      throw new Error(`refusing non-image content-type "${contentType}" from ${url}`);
    }

    const declared = res.headers.get("content-length");
    if (declared !== null && Number(declared) > this.maxImageBytes) {
      throw new Error(
        `image from ${url} exceeds max size (${declared} > ${String(this.maxImageBytes)} bytes)`,
      );
    }

    const bytes = await this.readCapped(res, url);
    return { bytes, contentType, sourceKey: url };
  }

  private assertAllowedHost(url: string): void {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      throw new Error(`invalid image url: ${url}`);
    }
    if (!this.allowedHosts.has(host)) {
      throw new Error(`refusing to fetch image from disallowed host: ${host}`);
    }
  }

  /** Read the body, aborting once it would exceed the cap (defends a lying/absent Content-Length). */
  private async readCapped(res: Response, url: string): Promise<Uint8Array> {
    const body: ReadableStream<Uint8Array> | null = res.body;
    const reader = body?.getReader();
    if (!reader) {
      // No stream available (e.g. a mocked Response) — fall back to the buffered
      // read but still enforce the cap on the materialized bytes.
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > this.maxImageBytes) {
        throw new Error(
          `image from ${url} exceeds max size (${String(bytes.length)} > ${String(this.maxImageBytes)} bytes)`,
        );
      }
      return bytes;
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > this.maxImageBytes) {
        await reader.cancel();
        throw new Error(
          `image from ${url} exceeds max size (> ${String(this.maxImageBytes)} bytes)`,
        );
      }
      chunks.push(value);
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  /** Idempotent PUT — skips the upload if the content-addressed key already exists. */
  async ingest(input: IngestInput): Promise<IngestResult> {
    const key = this.contentAddressedKey(input.sourceKey, input.contentType);
    const url = `${this.publicBaseUrl}/${key}`;

    if (await this.exists(key)) {
      return { key, url };
    }
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.bytes,
        ContentType: input.contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    this.logger.log(`ingested ${key} (${String(input.bytes.length)} bytes)`);
    return { key, url };
  }

  /** Fetch a provider URL and ingest in one step (the common worker path). */
  async ingestFromUrl(url: string): Promise<IngestResult> {
    return this.ingest(await this.fetchBytes(url));
  }

  private async exists(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
}

/** True for `image/*` content types (SVG included — fake-gen serves SVG heroes). */
function isImageContentType(contentType: string): boolean {
  return /^image\//i.test(contentType.split(";")[0]?.trim() ?? "");
}

function extensionFor(contentType: string): string {
  if (contentType.includes("svg")) return ".svg";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("webp")) return ".webp";
  return "";
}
