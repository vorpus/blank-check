import { type DeviceIdentityResponse } from "@dopamine/contracts";
import { Body, Controller, Headers, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Public } from "./device-auth.guard";
import { DeviceIdentityRequestDto, DeviceIdentityResponseDto } from "./identity.dto";
import { IdentityService } from "./identity.service";

/**
 * Identity controller (doc 01 §6/§7). `POST /v1/identity/device` is the anonymous
 * bootstrap: body `{ deviceId }` or the `X-Device-Id` header (charter §4.4); both
 * resolve to the same anonymous user and return a bearer token. Public — it's how
 * a client GETS a token, so it can't require one.
 */
@ApiTags("identity")
@Controller({ path: "identity", version: "1" })
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Post("device")
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Bootstrap/resolve an anonymous device identity, issue a bearer token" })
  @ApiOkResponse({ type: DeviceIdentityResponseDto })
  async device(
    @Body() body: DeviceIdentityRequestDto,
    @Headers("x-device-id") headerDeviceId?: string,
  ): Promise<DeviceIdentityResponse> {
    // Body field wins; the X-Device-Id header is the bootstrap alternative.
    const deviceId = body.deviceId ?? headerDeviceId ?? null;
    return this.identity.resolveDevice(deviceId);
  }
}
