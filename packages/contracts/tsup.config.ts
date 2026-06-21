import { defineConfig } from "tsup";

/**
 * Dual ESM + CJS build with type declarations.
 *
 * Why dual: `@dopamine/contracts` is imported by both ESM consumers
 * (Next.js / Vite / the browser bundle) and CJS-leaning consumers (NestJS via
 * ts-node/SWC, the small `fake-gen` service). Emitting both formats + `.d.ts`
 * means the package resolves cleanly everywhere regardless of the consumer's
 * `moduleResolution`, while keeping `zod` as the only runtime dependency.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
