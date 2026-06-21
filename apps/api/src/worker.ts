import { createServer } from "node:http";

import { NestFactory } from "@nestjs/core";

import { StructuredLogger } from "./common/logger";
import { OutboxRelay } from "./events/outbox-relay.service";
import { RedisService } from "./redis/redis.service";
import { FulfillmentWorker } from "./worker/fulfillment.worker";
import { GenerationWorker } from "./worker/generation.worker";
import { WorkerModule } from "./worker/worker.module";

/**
 * Worker entrypoint (doc 01 §11, charter §5.5.7). Boots the SAME app in worker
 * mode — a Nest application context with NO HTTP API listener — and registers the
 * BullMQ processors + the OutboxRelay. It DOES expose a tiny `/healthz` so the
 * compose healthcheck is a real readiness probe (can it reach Redis?), not a
 * liveness placeholder.
 */
export async function bootstrapWorker(): Promise<void> {
  const logger = new StructuredLogger("worker");
  const ctx = await NestFactory.createApplicationContext(WorkerModule, {
    logger,
    bufferLogs: false,
  });
  ctx.enableShutdownHooks();

  ctx.get(GenerationWorker).run();
  ctx.get(FulfillmentWorker).run();
  ctx.get(OutboxRelay).start();

  const redis = ctx.get(RedisService);
  const port = Number(process.env.WORKER_HEALTH_PORT ?? 8081);

  const health = createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    // Readiness = can we reach Redis (where BullMQ lives)?
    redis.client
      .ping()
      .then(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", role: "worker" }));
      })
      .catch(() => {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "degraded", role: "worker" }));
      });
  });
  health.listen(port, () => logger.log(`worker /healthz on :${String(port)}`));

  const shutdown = (signal: string): void => {
    logger.log(`worker shutting down (${signal})`);
    health.close();
    void ctx.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  logger.log("worker booted (BullMQ processors + outbox relay running)");
}

// Direct execution (the `worker` Docker role runs `node dist/worker.js`).
if (require.main === module) {
  void bootstrapWorker().catch((err: unknown) => {
     
    console.error("worker failed to boot:", err);
    process.exit(1);
  });
}
