import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

/**
 * fake-gen server entrypoint (doc 02). A tiny, stateless HTTP service on
 * port 8090 implementing the `GenerationProvider` content surface. No
 * dependency on Postgres / Redis / MinIO / credentials — that's the whole
 * boundary point (doc 02 §8): it is a pure content function so Stage 2 is a
 * container swap, not an `api` refactor.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = buildApp(cfg);

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, "fake-gen shutting down");
    void app.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await app.listen({ port: cfg.port, host: cfg.host });
    app.log.info(
      {
        port: cfg.port,
        mediaMode: cfg.mediaMode,
        mediaDelayMs: cfg.mediaDelayMs,
        failureRate: cfg.failureRate,
        stream: cfg.stream,
      },
      "fake-gen listening",
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
