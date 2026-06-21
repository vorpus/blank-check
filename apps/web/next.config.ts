import { type NextConfig } from "next";

/**
 * Next.js config (App Router).
 *
 * `output: "standalone"` is load-bearing: `apps/web/Dockerfile` copies
 * `.next/standalone` + `.next/static` + `public/` and runs `node apps/web/server.js`.
 * Without it the runtime stage has no server bundle.
 *
 * `transpilePackages` lets Next compile the workspace TS packages directly; the
 * SDK + contracts publish dual ESM/CJS, but transpiling source keeps the dev loop
 * and the standalone trace honest about the workspace graph.
 *
 * Remote placeholder/hero images come from `fake-gen` (SVG over MinIO/HTTP); we
 * render them with a plain <img> via `MediaImage` (no next/image loader, no remote
 * allowlist to maintain), so no `images` config is needed in Stage 1.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  // The standalone tracer must walk up to the repo root to include workspace deps.
  outputFileTracingRoot: process.cwd().replace(/\/apps\/web$/, ""),
  transpilePackages: ["@dopamine/contracts", "@dopamine/sdk"],
  reactStrictMode: true,
  eslint: {
    // We run eslint as its own `lint` task (turbo); don't double-run it in build.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
