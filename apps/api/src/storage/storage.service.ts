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

  constructor(@Inject(ENV) env: Env) {
    this.bucket = env.S3_BUCKET;
    this.publicBaseUrl = env.S3_PUBLIC_BASE_URL.replace(/\/$/, "");
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

  /** Fetch bytes from a provider URL (fake-gen `/img/...`). */
  async fetchBytes(url: string): Promise<IngestInput> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`failed to fetch image bytes from ${url}: HTTP ${String(res.status)}`);
    }
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, contentType, sourceKey: url };
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

function extensionFor(contentType: string): string {
  if (contentType.includes("svg")) return ".svg";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("webp")) return ".webp";
  return "";
}
