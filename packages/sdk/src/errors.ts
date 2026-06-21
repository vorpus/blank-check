import { ErrorEnvelopeSchema, type ErrorEnvelope } from "@dopamine/contracts";

/**
 * `ApiError` — the typed error every non-2xx response becomes (doc 05 §6).
 *
 * The server returns one envelope shape for every error (`ErrorEnvelopeSchema`,
 * doc 05 §6.3). `toApiError` parses the body through that schema and throws a
 * typed `ApiError`, so consumers branch on `err.code` (`"not_found"`,
 * `"conflict"`, `"rate_limited"`, …) and read `err.requestId` for correlation —
 * never inspect raw HTTP. If the body is NOT a valid envelope (e.g. a proxy 502
 * or an HTML error page), we still surface a typed `ApiError` with a synthetic
 * code so the boundary never leaks an untyped throw.
 */
export class ApiError extends Error {
  /** Stable machine code from the envelope (`ERROR_CODES`), or a synthetic one. */
  readonly code: string;
  /** HTTP status that produced this error. */
  readonly status: number;
  /** Correlation id (arch 01 §8.4); `"unknown"` if the body wasn't an envelope. */
  readonly requestId: string;
  /** Optional structured detail (e.g. Zod issues on a 400). */
  readonly details: Record<string, unknown> | undefined;

  constructor(args: {
    code: string;
    message: string;
    status: number;
    requestId: string;
    details?: Record<string, unknown> | undefined;
  }) {
    super(args.message);
    this.name = "ApiError";
    this.code = args.code;
    this.status = args.status;
    this.requestId = args.requestId;
    this.details = args.details;
    // Restore the prototype chain across the ES5/transpile boundary so
    // `instanceof ApiError` is reliable for consumers.
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/** Type guard so consumers can narrow a caught `unknown` to `ApiError`. */
export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/**
 * Turn a non-2xx `Response` into a typed `ApiError` by parsing its body through
 * `ErrorEnvelopeSchema`. Reads the body defensively (it may be empty or not JSON)
 * and always resolves to an `ApiError` — it never throws while building the error.
 */
export async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }

  const parsed = ErrorEnvelopeSchema.safeParse(body);
  if (parsed.success) {
    const env: ErrorEnvelope = parsed.data;
    return new ApiError({
      code: env.error.code,
      message: env.error.message,
      status: res.status,
      requestId: env.error.requestId,
      details: env.error.details,
    });
  }

  // Not a contract envelope — synthesize a typed error so nothing untyped leaks.
  return new ApiError({
    code: `http_${String(res.status)}`,
    message:
      res.statusText || `request failed with status ${String(res.status)}`,
    status: res.status,
    requestId: "unknown",
  });
}
