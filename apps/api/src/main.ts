import { createApp } from "./bootstrap";
import { StructuredLogger } from "./common/logger";
import { OutboxRelay } from "./events/outbox-relay.service";
import { buildOpenApiDocument, setupSwaggerUi } from "./openapi";

/**
 * api entrypoint (doc 01 §11). Boots the full Nest HTTP app (Fastify), mounts the
 * OpenAPI doc + Swagger UI, starts the OutboxRelay (the relay runs in BOTH api and
 * worker), and listens on PORT. The `api` Docker role runs `node dist/main.js`.
 */
async function bootstrap(): Promise<void> {
  const logger = new StructuredLogger("api");
  const app = await createApp();

  const doc = buildOpenApiDocument(app);
  setupSwaggerUi(app, doc);

  // The relay drains the transactional outbox to Redis pub/sub. Running it in the
  // api too means listing.generated / images.* fan out even if the worker is down.
  app.get(OutboxRelay).start();

  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: "0.0.0.0" });
  logger.log(`api listening on :${String(port)} (docs at /v1/docs)`);

  // Graceful shutdown (mirrors the worker): on SIGTERM/SIGINT close the Nest app,
  // which runs every provider's onModuleDestroy — stopping the OutboxRelay timer
  // and closing the producer-side BullMQ Queue's Redis connection — before exit.
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    logger.log(`api shutting down (${signal})`);
    void app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {

        console.error("api shutdown failed:", err);
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

void bootstrap().catch((err: unknown) => {
   
  console.error("api failed to boot:", err);
  process.exit(1);
});
