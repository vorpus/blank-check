import { z } from "zod";

/**
 * Anonymous-first identity (doc 05 §4.4). `POST /v1/identity/device` issues/looks
 * up an anonymous `user` keyed on `deviceId` and returns a short-lived bearer
 * token. The same bearer scheme is reused for real accounts in Stage 4 — account
 * upgrade is "swap the token issuer," not a re-plumb.
 */

export const DeviceIdentityRequestSchema = z.object({
  deviceId: z.string().nullable().default(null), // null on first boot → server mints one
});
export type DeviceIdentityRequest = z.infer<typeof DeviceIdentityRequestSchema>;

export const BearerTokenSchema = z.object({
  accessToken: z.string(), // sent as `Authorization: Bearer <token>`
  tokenType: z.literal("Bearer"),
  expiresInSec: z.number().int().positive(),
});
export type BearerToken = z.infer<typeof BearerTokenSchema>;

export const DeviceIdentityResponseSchema = z.object({
  deviceId: z.string(), // dev_… (echoed or newly minted)
  userId: z.string(), // usr_… (anonymous user row)
  token: BearerTokenSchema,
});
export type DeviceIdentityResponse = z.infer<typeof DeviceIdentityResponseSchema>;
