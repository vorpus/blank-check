import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * Vitest is the workspace's test runner (contracts + fake-gen already use it), so
 * the api stays on ONE runner — no Jest. NestJS DI + nestjs-zod decorators need
 * `emitDecoratorMetadata`, which esbuild (vitest's default transform) does NOT
 * emit; the SWC plugin supplies it. Tests run in the node environment.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  // Vitest 4 transforms with Oxc by default, which (like esbuild) doesn't emit
  // decorator metadata. Disable it so the SWC plugin above is the authoritative
  // transform for NestJS decorators.
  esbuild: false,
  oxc: false,
  test: {
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    environment: "node",
    globals: true,
  },
});
