import { z } from "zod";

/**
 * Environment schema (charter §3, doc 01 §3). Every env var the api/worker reads
 * is parsed once at boot against this Zod schema; a bad/missing var fails fast
 * with a readable error instead of surfacing as an undefined deep in a service.
 *
 * The var NAMES match docker-compose.yml's `x-app-env` anchor exactly
 * (DATABASE_URL, REDIS_URL, FAKEGEN_URL, S3_*). Do not rename without updating
 * compose + .env.example.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  FAKEGEN_URL: z.string().min(1).default("http://fake-gen:8090"),

  // S3 / MinIO (AWS SDK v3). S3_PUBLIC_BASE_URL is what we persist on listings so
  // the browser can <img src> straight from MinIO (→ CDN URL in Stage 5).
  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("listing-images"),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .union([z.literal("true"), z.literal("false")])
    .default("true")
    .transform((v) => v === "true"),
  S3_PUBLIC_BASE_URL: z.string().min(1).default("http://localhost:9000/listing-images"),

  // Image-ingest hardening (SSRF + resource limits). The backend fetches provider
  // image bytes before PUTting them to MinIO; cap the size and reject non-image
  // content. Host allowlisting is derived from FAKEGEN_URL (the only provider we
  // ingest from); MAX_IMAGE_BYTES bounds a single fetched blob.
  MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024), // 5 MiB

  // Identity bearer signing. Stage 1 uses a symmetric secret; Stage 4 swaps the
  // issuer, not the verification plumbing (charter §4.4).
  JWT_SECRET: z.string().min(1).default("dopamine-stage1-dev-secret-not-for-prod"),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(43200), // 12h

  // Fulfillment time compression (doc 01 §10) — consumed in 3b; parsed now so the
  // env shape is frozen.
  TIME_SCALE: z.coerce.number().positive().default(3600),

  // Generation tuning (doc 01 §5).
  GRID_TARGET: z.coerce.number().int().positive().default(24),
  COLD_BATCH: z.coerce.number().int().positive().default(8),
  GEN_LOCK_TTL_MS: z.coerce.number().int().positive().default(30000),
  GEN_MAX_CONCURRENCY: z.coerce.number().int().positive().default(8),
  // Exact-cache (canon → anchor listingId) TTL. Bounded so a stale/pruned anchor
  // listing can't be served from the L1 cache forever.
  EXACT_CACHE_TTL_SEC: z.coerce.number().int().positive().default(3600), // 1h
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
