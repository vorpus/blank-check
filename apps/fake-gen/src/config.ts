/**
 * Runtime configuration, all from env (doc 02 §7). These knobs let a reviewer
 * feel the skeleton → placeholder → ready timing and force the `degraded` path
 * on demand — without redeploying.
 *
 * STAGE 2 SEAM: the *names* of these knobs map to real provider behaviour
 * (latency, failure, grid size); the real pipeline reads the analogous config
 * (provider timeouts, retry budgets) at the same layer.
 */

function int(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
}

function float(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : def;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  return raw === "1" || raw.toLowerCase() === "true";
}

export type MediaMode = "twophase" | "inline";

export interface FakeGenConfig {
  /** Listen port (doc 02 §7, compose maps 8090:8090). */
  port: number;
  /** Bind host — 0.0.0.0 so the container is reachable on its network. */
  host: string;
  /** Artificial delay before POST /generate responds (fast-path text latency). */
  textDelayMs: number;
  /** Delay before final media becomes available (drives expected_ready_ms + swap). */
  mediaDelayMs: number;
  /** `twophase` (placeholder then async ready) or `inline` (ready immediately). */
  mediaMode: MediaMode;
  /** Probability (0..1) a generation resolves `degraded`. Deterministic per gen. */
  failureRate: number;
  /** Enables the COLD field-by-field token stream (§6.1). */
  stream: boolean;
  /** Per-chunk cadence for the token stream. */
  streamDeltaMs: number;
  /** Makes POST /generate return the generation_failed error envelope (§2.3). */
  failGenerate: boolean;
  /** `count` used if the caller omits it. */
  defaultCount: number;
  /** Upper bound honored for `count` (matches §4.7 gridTarget). */
  gridMax: number;
  /** Public base URL of this service, used to build fetchable image URLs. */
  publicBaseUrl: string;
  /** Fastify log level. */
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FakeGenConfig {
  const port = int("FAKE_GEN_PORT", 8090);
  const modeRaw = env.FAKE_MEDIA_MODE ?? "twophase";
  const mediaMode: MediaMode = modeRaw === "inline" ? "inline" : "twophase";
  return {
    port,
    host: env.FAKE_GEN_HOST ?? "0.0.0.0",
    textDelayMs: Math.max(0, int("FAKE_TEXT_DELAY_MS", 0)),
    mediaDelayMs: Math.max(0, int("FAKE_MEDIA_DELAY_MS", 1500)),
    mediaMode,
    failureRate: Math.min(1, Math.max(0, float("FAKE_FAILURE_RATE", 0))),
    stream: bool("FAKE_STREAM", false),
    streamDeltaMs: Math.max(0, int("FAKE_STREAM_DELTA_MS", 60)),
    failGenerate: bool("FAKE_FAIL_GENERATE", false),
    defaultCount: Math.max(1, int("FAKE_DEFAULT_COUNT", 1)),
    gridMax: Math.max(1, int("FAKE_GRID_MAX", 24)),
    // `fake-gen:8090` inside compose; overridable for local curl / tests.
    publicBaseUrl: env.FAKE_GEN_PUBLIC_BASE_URL ?? `http://fake-gen:${String(port)}`,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
