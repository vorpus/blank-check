import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";

import { ENV } from "../config/config.module";
import { type Env } from "../config/env";

import { DeviceAuthGuard } from "./device-auth.guard";
import { IdentityController } from "./identity.controller";
import { IdentityService } from "./identity.service";

/**
 * IdentityModule (doc 01 §6). Owns the `users` table, the bearer issuer, and the
 * DeviceAuthGuard. Exports IdentityService so the guard (registered globally in
 * AppModule) can verify tokens.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        secret: env.JWT_SECRET,
        signOptions: { expiresIn: env.JWT_TTL_SECONDS },
      }),
    }),
  ],
  controllers: [IdentityController],
  providers: [IdentityService, DeviceAuthGuard],
  exports: [IdentityService, DeviceAuthGuard],
})
export class IdentityModule {}
