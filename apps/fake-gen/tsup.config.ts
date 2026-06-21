import { defineConfig } from "tsup";

/**
 * Build the standalone fake-gen service to a single Node ESM entrypoint.
 *
 * `@dopamine/contracts` is bundled in (`noExternal`) so the runtime image only
 * needs the deployed `node_modules` for `fastify` + `zod` and does not have to
 * resolve the workspace package at runtime. Server-only, ESM, Node 22+ target.
 */
export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: false,
  sourcemap: true,
  clean: true,
  noExternal: ["@dopamine/contracts"],
});
