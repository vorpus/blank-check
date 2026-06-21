import { ErrorEnvelopeSchema, type ErrorEnvelope } from "@dopamine/contracts";
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { type FastifyReply } from "fastify";

import { DomainException } from "./errors";
import { StructuredLogger } from "./logger";
import { requestContext } from "./request-context";

/**
 * Global exception filter (doc 01 §3, doc 05 §6.3). EVERY non-2xx response is
 * shaped as the contract ErrorEnvelope so the SDK can turn it into a typed
 * ApiError. The `requestId` comes from the propagated request context, so the
 * client can correlate a failure with server logs.
 */
@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new StructuredLogger("error-filter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const requestId = requestContext.requestId();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = "internal_error";
    let message = "internal server error";
    let details: Record<string, unknown> | undefined;

    if (exception instanceof DomainException) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      code = httpStatusToCode(status);
      if (typeof res === "string") {
        message = res;
      } else if (res && typeof res === "object") {
        const obj = res as { message?: unknown; error?: unknown };
        message = Array.isArray(obj.message)
          ? obj.message.join(", ")
          : typeof obj.message === "string"
            ? obj.message
            : exception.message;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(`unhandled error: ${exception.message}`, exception.stack);
    }

    const envelope: ErrorEnvelope = ErrorEnvelopeSchema.parse({
      error: { code, message, requestId, ...(details ? { details } : {}) },
    });

    if (Number(status) >= 500) {
      this.logger.error(`${code}: ${message}`, undefined, "error-filter");
    }

    void reply.status(status).send(envelope);
  }
}

// Status → conventional error code (doc 05 §6.3). A plain numeric map avoids an
// enum/number comparison mismatch and is trivially extensible.
const STATUS_CODE: Record<number, string> = {
  400: "validation_error",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
};

function httpStatusToCode(status: number): string {
  return STATUS_CODE[Number(status)] ?? "internal_error";
}
