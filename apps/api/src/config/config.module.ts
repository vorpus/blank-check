import { Global, Module } from "@nestjs/common";

import { type Env, loadEnv } from "./env";

/** DI token for the parsed, validated environment (doc 01 §3). */
export const ENV = Symbol("ENV");

/**
 * ConfigModule — parses the environment once via the Zod schema and exposes the
 * typed `Env` object as a global provider. Global so every module can inject
 * `@Inject(ENV)` without importing this module explicitly.
 */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
