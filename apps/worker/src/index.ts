/**
 * `@dopamine/worker` — the worker entrypoint as a named package (doc 05 §2).
 *
 * The charter (§2; doc 01 §11) pins api + worker as ONE codebase / ONE Docker
 * image with two entrypoints. The actual bootstrap lives in `@dopamine/api`'s
 * `worker.ts` and runs as the `worker` Docker role (`node dist/worker.js`). This
 * package only NAMES the worker in the monorepo layout so Stage 6 can add per-app
 * config additively; it deliberately carries no logic of its own.
 *
 * To run the worker outside Docker, use the api script: `pnpm --filter
 * @dopamine/api start:worker` (compiled) or `dev:worker` (tsx watch).
 */
export const WORKER_ENTRYPOINT = "@dopamine/api → dist/worker.js (role: worker)";
