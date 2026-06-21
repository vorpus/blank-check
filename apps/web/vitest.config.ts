import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * Component + hook tests run under jsdom with @testing-library/react. Vitest 4
 * transforms with Oxc/Rolldown by default, which doesn't reliably parse our TSX
 * with the React automatic runtime — so (mirroring the api's vitest setup) we use
 * the SWC plugin as the authoritative transform and disable the built-in ones.
 * `setup.ts` wires jest-dom matchers + cleanup.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", tsx: true },
        transform: {
          react: { runtime: "automatic" },
        },
      },
    }),
  ],
  esbuild: false,
  oxc: false,
  test: {
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules", ".next", "dist"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
});
