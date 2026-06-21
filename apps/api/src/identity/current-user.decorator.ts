import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

import { UnauthorizedError } from "../common/errors";

import { type AuthedRequest } from "./device-auth.guard";
import { type AuthPrincipal } from "./identity.service";

/**
 * `@CurrentUser()` — pulls the verified principal off the request (set by
 * DeviceAuthGuard). Throws 401 if used on a route the guard didn't protect.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw new UnauthorizedError("no authenticated principal");
    return req.user;
  },
);
