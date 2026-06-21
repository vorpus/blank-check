import Fastify, { type FastifyInstance } from "fastify";

import { type FakeGenConfig } from "./config.js";
import { svgImage, type ImageKind } from "./images.js";
import { GenerateFailedError, GenerationService } from "./service.js";
import { GenerateRequestSchema, GenStreamEventSchema } from "./wire.js";

/**
 * The Fastify app (routes only). Kept separate from `server.ts` so tests can use
 * `app.inject()` without binding a port.
 *
 * WHY FASTIFY (vs Hono): the rest of the backend (doc 01) runs NestJS on the
 * Fastify adapter, and the charter pins Fastify there — so fake-gen sharing the
 * Fastify request lifecycle keeps the team on one server model with no extra
 * runtime to reason about. Hono would also work (it's lighter), but Fastify's
 * mature logging + lifecycle hooks are worth more here than Hono's edge focus,
 * and there's zero benefit to a second framework in the monorepo.
 */
export function buildApp(cfg: FakeGenConfig): FastifyInstance {
  const app = Fastify({
    logger: { level: cfg.logLevel },
    // We do our own Zod validation; keep Fastify's body limit sane.
    bodyLimit: 1 << 20,
  });
  const svc = new GenerationService(cfg);

  // --- Liveness -------------------------------------------------------------
  app.get("/healthz", () => ({ status: "ok", service: "fake-gen" }));

  // --- Fast path: POST /generate -------------------------------------------
  app.post("/generate", async (req, reply) => {
    const parsed = GenerateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(validationError(req.id, parsed.error.issues));
    }
    try {
      return await svc.generate(parsed.data);
    } catch (err) {
      if (err instanceof GenerateFailedError) {
        return reply.status(502).send({
          error: { type: "generation_failed", message: err.message, retryable: true },
        });
      }
      throw err;
    }
  });

  // --- Grid: POST /generate-grid (the generateGrid provider method) ---------
  // Identical to /generate but `count` is required; provided as a named seam so
  // the backend can call the grid method explicitly.
  app.post("/generate-grid", async (req, reply) => {
    const parsed = GenerateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(validationError(req.id, parsed.error.issues));
    }
    if (parsed.data.count === undefined) {
      return reply.status(400).send(validationError(req.id, [{ message: "`count` is required for /generate-grid" }]));
    }
    try {
      return await svc.generate(parsed.data);
    } catch (err) {
      if (err instanceof GenerateFailedError) {
        return reply.status(502).send({
          error: { type: "generation_failed", message: err.message, retryable: true },
        });
      }
      throw err;
    }
  });

  // --- Readiness poll: GET /media/:generationId -----------------------------
  app.get<{ Params: { generationId: string } }>("/media/:generationId", (req) => {
    return svc.mediaFor(req.params.generationId);
  });

  // --- Image bytes: GET /img/:dir/:key.svg ----------------------------------
  // The backend fetches these and ingests to MinIO (doc 02 §5.3). fake-gen never
  // writes the bucket. The image is re-derived deterministically from the key —
  // stateless, content-addressed, idempotent to re-ingest.
  app.get<{ Params: { dir: string; file: string } }>("/img/:dir/:file", (req, reply) => {
    const { dir, file } = req.params;
    if (dir !== "ph" && dir !== "fin") {
      return reply.status(404).send({ error: { type: "not_found", message: "unknown image dir", retryable: false } });
    }
    const match = /^([0-9a-f]{24})\.svg$/.exec(file);
    if (!match) {
      return reply.status(404).send({ error: { type: "not_found", message: "bad image key", retryable: false } });
    }
    const key = match[1];
    const kind: ImageKind = dir === "fin" ? "final" : "placeholder";
    const svg = renderImageByKey(key ?? "", kind);
    return reply
      .header("content-type", "image/svg+xml; charset=utf-8")
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(svg);
  });

  // --- Optional COLD token stream: GET /generate/stream (SSE) ----------------
  app.get("/generate/stream", async (req, reply) => {
    const parsed = GenerateRequestSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send(validationError(req.id, parsed.error.issues));
    }
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for await (const ev of svc.streamText(parsed.data)) {
      // Validate each event against the wire schema (drift gate) before emitting.
      const safe = GenStreamEventSchema.parse(ev);
      reply.raw.write(`event: ${safe.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(safe)}\n\n`);
    }
    reply.raw.write("event: done\ndata: {}\n\n");
    reply.raw.end();
    return reply;
  });

  return app;
}

/**
 * Re-derive an image purely from its content-addressed key.
 *
 * The key is `digestHex(kind|query|variant|slot)`, which is one-way — we cannot
 * recover `query`/`variant`/`slot` from it. So the byte endpoint renders a
 * deterministic SVG *keyed on the digest itself* (a stable colour + the short key
 * as a label). This is sufficient for Stage 1: the bytes are stable per URL,
 * content-addressed, and the visible query text already rides on the listing
 * card; the placeholder image only needs to be a stable, distinct, fake tile.
 *
 * (If a future stage wants the query rendered into the image bytes too, encode it
 * into the URL path instead of hashing it — the `MediaAsset.url` is the seam.)
 */
function renderImageByKey(key: string, kind: ImageKind): string {
  // Use the key as the "query" so the same URL always yields the same SVG.
  return svgImage(key, 0, kind, "self");
}

interface ZodIssueLike {
  message: string;
}

function validationError(requestId: string, issues: ZodIssueLike[]) {
  return {
    error: {
      code: "validation_error",
      message: "request failed validation",
      requestId,
      details: { issues: issues.map((i) => i.message) },
    },
  };
}
