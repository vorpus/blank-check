import { z } from "zod";

/**
 * The single error envelope every non-2xx response uses (doc 05 §6.3).
 * The SDK turns this into a typed `ApiError`.
 *
 * Conventional code → status mappings (owned by doc 01, fixed here):
 *   400 validation_error · 401 unauthorized · 404 not_found ·
 *   409 conflict · 429 rate_limited.
 */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/**
 * The conventional error codes. Not an exhaustive enum on the wire (the `code`
 * field is an open string for forward-compat), but exported as a typed set of
 * the known values so callers can switch over them ergonomically.
 */
export const ERROR_CODES = {
  validation_error: "validation_error",
  unauthorized: "unauthorized",
  not_found: "not_found",
  conflict: "conflict",
  rate_limited: "rate_limited",
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
