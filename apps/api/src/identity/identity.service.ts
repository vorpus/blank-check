import { type BearerToken, type DeviceIdentityResponse } from "@dopamine/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

import { UnauthorizedError } from "../common/errors";
import { mintId } from "../common/ids";
import { ENV } from "../config/config.module";
import { type Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";

/** The verified bearer payload attached to `req.user` (charter §4.4). */
export interface AuthPrincipal {
  userId: string;
  deviceId: string;
  kind: string;
}

/** JWT claims we sign. `sub` = userId; the same scheme Stage 4 reuses. */
interface DeviceClaims {
  sub: string;
  deviceId: string;
  kind: string;
}

/**
 * IdentityService (doc 01 §6, charter §4.4) — anonymous-first identity. A deviceId
 * resolves/creates a lightweight anonymous `user`; a short-lived bearer token
 * scopes requests. The bearer scheme is exactly what Stage 4 reuses for real
 * accounts — account upgrade is "swap the token issuer", not a re-plumb.
 */
@Injectable()
export class IdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Resolve (or create) the anonymous user for a deviceId. Mints one if absent. */
  async resolveDevice(deviceId: string | null): Promise<DeviceIdentityResponse> {
    const resolvedDeviceId = deviceId ?? mintId("device");
    const user = await this.prisma.user.upsert({
      where: { deviceId: resolvedDeviceId },
      update: {},
      create: { id: mintId("user"), deviceId: resolvedDeviceId, kind: "anonymous" },
    });
    return {
      deviceId: user.deviceId,
      userId: user.id,
      token: this.issueToken({ sub: user.id, deviceId: user.deviceId, kind: user.kind }),
    };
  }

  private issueToken(claims: DeviceClaims): BearerToken {
    const accessToken = this.jwt.sign(claims, { expiresIn: this.env.JWT_TTL_SECONDS });
    return { accessToken, tokenType: "Bearer", expiresInSec: this.env.JWT_TTL_SECONDS };
  }

  /** Verify a bearer token → principal, or throw 401 (used by DeviceAuthGuard). */
  verify(token: string): AuthPrincipal {
    try {
      // Pin the algorithm so a token can't be coerced to a different scheme
      // (e.g. an alg-confusion downgrade); Stage 1 signs HS256.
      const claims = this.jwt.verify<DeviceClaims>(token, { algorithms: ["HS256"] });
      return { userId: claims.sub, deviceId: claims.deviceId, kind: claims.kind };
    } catch {
      throw new UnauthorizedError("invalid or expired bearer token");
    }
  }
}
