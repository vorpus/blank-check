/**
 * `@dopamine/api` public surface. The api is primarily an executable — `main.ts`
 * (the api role) and `worker.ts` (the worker role) are the real entrypoints. These
 * exports exist for tests + tooling that need the composition root.
 */
export { bootstrapWorker } from "./worker";
export { createApp } from "./bootstrap";
export { AppModule } from "./app.module";
