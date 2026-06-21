import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createApp } from "./bootstrap";
import { buildOpenApiDocument } from "./openapi";

/**
 * openapi:dump (doc 05 §3.2) — boots the Nest app in "spec mode" (build the
 * routing graph, never `listen()`), serializes the OpenAPI 3.1 document, writes it
 * to `openapi.json` (and an optional path arg), and exits. This is the drift gate:
 * `make sdk` regenerates the SDK transport types from this artifact, and CI fails
 * if the committed spec drifts from the contracts.
 *
 * The spec is a PURE schema build (doc 05 §3.2): no datastore is required. The env
 * schema still parses at DI time, so we seed harmless placeholders for any absent
 * vars — the spec only needs the routing graph, never a live DB/Redis/MinIO. The
 * imported modules don't open connections on load; only `createApp()` resolves DI,
 * by which point the placeholders are set.
 */
const SPEC_ENV_DEFAULTS: Record<string, string> = {
  DATABASE_URL: "postgresql://spec:spec@localhost:5432/spec",
  REDIS_URL: "redis://localhost:6379",
  S3_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY_ID: "spec",
  S3_SECRET_ACCESS_KEY: "spec",
};

async function dump(): Promise<void> {
  for (const [key, value] of Object.entries(SPEC_ENV_DEFAULTS)) {
    process.env[key] ??= value;
  }

  // No app.init() — that would open DB/Redis connections. NestFactory.create
  // already resolves the routing graph, which is all the spec build needs.
  const app = await createApp();
  const doc = buildOpenApiDocument(app);
  const json = JSON.stringify(doc, null, 2);

  const outArg = process.argv[2];
  const outPath = resolve(outArg ?? "openapi.json");
  writeFileSync(outPath, json);
  process.stderr.write(`openapi 3.1 spec written to ${outPath} (${String(doc.openapi)})\n`);

  await app.close();
  process.exit(0);
}

void dump().catch((err: unknown) => {
  console.error("openapi:dump failed:", err);
  process.exit(1);
});
