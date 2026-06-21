import { defineConfig } from "tsup";

/**
 * Dual ESM + CJS build with type declarations — mirrors `@dopamine/contracts`.
 *
 * Why dual: `@dopamine/sdk` is consumed by Next.js / Vite (ESM) now and, in
 * Stage 6, React Native (Metro) — emitting both formats + `.d.ts` resolves cleanly
 * everywhere. The only runtime dependency is `@dopamine/contracts` (+ zod
 * transitively); `openapi.gen.ts` is types-only and erases at build time
 * (zero runtime cost). `fetch`/`getToken`/`EventSource` are injected, so nothing
 * browser- or node-specific is bundled in.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  external: ["@dopamine/contracts"],
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
