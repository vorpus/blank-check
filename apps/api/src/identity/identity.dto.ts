import { DeviceIdentityRequestSchema, DeviceIdentityResponseSchema } from "@dopamine/contracts";
import { createZodDto } from "nestjs-zod";

/**
 * DTOs derived from the canonical `@dopamine/contracts` schemas via `createZodDto`
 * (doc 01 §7.3). One source of truth: the SAME schema validates the request at
 * runtime (via ZodValidationPipe reading the DTO's static schema) AND drives the
 * OpenAPI document (nestjs-zod's SwaggerModule patch). No hand-written DTO drift.
 */
export class DeviceIdentityRequestDto extends createZodDto(DeviceIdentityRequestSchema) {}
export class DeviceIdentityResponseDto extends createZodDto(DeviceIdentityResponseSchema) {}
