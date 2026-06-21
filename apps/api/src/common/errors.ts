import { ERROR_CODES } from "@dopamine/contracts";
import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * Domain exceptions that map cleanly onto the contract ErrorEnvelope (doc 05
 * §6.3). Each carries a stable `code` + HTTP status; the ErrorEnvelopeFilter
 * serializes them into `{ error: { code, message, requestId, details? } }`.
 *
 * Conventional mappings (doc 05 §6.3): 400 validation_error · 401 unauthorized ·
 * 404 not_found · 409 conflict · 429 rate_limited.
 */
export class DomainException extends HttpException {
  constructor(
    // Open string (the wire `code` is forward-compat) — known codes come from
    // ERROR_CODES but the field accepts any string by design (doc 05 §6.3).
    readonly code: string,
    message: string,
    status: HttpStatus,
    readonly details?: Record<string, unknown>,
  ) {
    super(message, status);
  }
}

export class NotFoundError extends DomainException {
  constructor(message = "resource not found", details?: Record<string, unknown>) {
    super(ERROR_CODES.not_found, message, HttpStatus.NOT_FOUND, details);
  }
}

export class UnauthorizedError extends DomainException {
  constructor(message = "missing or invalid credentials") {
    super(ERROR_CODES.unauthorized, message, HttpStatus.UNAUTHORIZED);
  }
}

export class ConflictError extends DomainException {
  constructor(message = "conflict", details?: Record<string, unknown>) {
    super(ERROR_CODES.conflict, message, HttpStatus.CONFLICT, details);
  }
}

export class ValidationError extends DomainException {
  constructor(message = "request failed validation", details?: Record<string, unknown>) {
    super(ERROR_CODES.validation_error, message, HttpStatus.BAD_REQUEST, details);
  }
}

export class RateLimitedError extends DomainException {
  constructor(message = "rate limited") {
    super(ERROR_CODES.rate_limited, message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** Thrown by the VerticalRegistry when an unknown vertical id is requested. */
export class UnknownVerticalError extends DomainException {
  constructor(verticalId: string) {
    super("unknown_vertical", `unknown vertical: ${verticalId}`, HttpStatus.BAD_REQUEST, { verticalId });
  }
}
