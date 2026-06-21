import { randomUUID } from "node:crypto";
import { type IncomingMessage } from "node:http";

import { type INestApplication, VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { AppModule } from "./app.module";
import { StructuredLogger } from "./common/logger";
import { requestContext } from "./common/request-context";

/**
 * Build the Nest Fastify application with all cross-cutting wiring (doc 01 §7).
 * Shared by `main.ts` (serve) and `openapi-dump.ts` (build the spec, no listen)
 * so the spec is a faithful projection of the SAME app that serves traffic.
 *
 * - URI versioning → routes declared `version: "1"` mount under `/v1`.
 * - A Fastify onRequest hook seeds the propagated requestId (used by the logger
 *   + the ErrorEnvelope filter) from an incoming `x-request-id` or a fresh UUID.
 */
export async function createApp(): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({ logger: false });

  // Seed the request context BEFORE the Nest pipeline so every log line + error
  // envelope inside a request carries the same requestId. Typed via the raw node
  // request to avoid a FastifyRequest version clash between fastify and the copy
  // bundled inside @nestjs/platform-fastify.
  adapter
    .getInstance()
    .addHook("onRequest", (req: { raw: IncomingMessage }, _reply: unknown, done: () => void) => {
      const incoming = req.raw.headers["x-request-id"];
      const requestId = typeof incoming === "string" && incoming.length > 0 ? incoming : randomUUID();
      // enterWith binds the store to this request's async context for the whole
      // lifecycle (guard → pipe → handler → filter), so logs + errors correlate.
      requestContext.enterWith({ requestId });
      done();
    });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: new StructuredLogger("api"),
    bufferLogs: false,
  });

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  app.enableCors({ origin: process.env.CORS_ORIGIN ?? "http://localhost:3000", credentials: true });
  app.enableShutdownHooks();

  return app;
}

/** Re-export for callers that only need the app type. */
export type { INestApplication };
