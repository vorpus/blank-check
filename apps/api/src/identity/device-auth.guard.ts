import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { type FastifyRequest } from "fastify";

import { UnauthorizedError } from "../common/errors";
import { requestContext } from "../common/request-context";

import { IdentityService, type AuthPrincipal } from "./identity.service";

/** Mark a route/handler as public (no bearer required), e.g. identity bootstrap. */
export const PUBLIC_ROUTE = "isPublicRoute";
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE, true);

/** Augmented request carrying the verified principal. */
export interface AuthedRequest extends FastifyRequest {
  user?: AuthPrincipal;
}

/**
 * DeviceAuthGuard (doc 01 §6, charter §4.4) — validates `Authorization: Bearer
 * <token>` on protected routes and attaches `req.user`. `@Public()` routes skip
 * it (identity bootstrap, health). The bearer is the anonymous device token now,
 * the real-account token in Stage 4 — same verification, swapped issuer.
 */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(
    private readonly identity: IdentityService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw new UnauthorizedError("missing bearer token");
    }
    const principal = this.identity.verify(header.slice("Bearer ".length).trim());
    req.user = principal;
    requestContext.setUserId(principal.userId);
    return true;
  }
}
