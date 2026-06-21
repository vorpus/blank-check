import { type LoggerService } from "@nestjs/common";

import { requestContext } from "./request-context";

type Level = "log" | "error" | "warn" | "debug" | "verbose";

/**
 * StructuredLogger — emits one JSON object per line with the propagated
 * `requestId` (doc 01 §12). Implements Nest's LoggerService so it slots in via
 * `app.useLogger()` and the worker context. JSON logs are grep/jq-friendly and
 * map cleanly onto a log aggregator in Stage 5.
 */
export class StructuredLogger implements LoggerService {
  constructor(private readonly defaultContext = "app") {}

  private write(level: Level, message: unknown, context?: string, extra?: unknown): void {
    const line = {
      ts: new Date().toISOString(),
      level,
      requestId: requestContext.requestId(),
      context: context ?? this.defaultContext,
      message: stringifyMessage(message),
      ...(extra !== undefined ? { detail: extra } : {}),
    };
    const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
    out.write(`${JSON.stringify(line)}\n`);
  }

  log(message: unknown, context?: string): void {
    this.write("log", message, context);
  }
  error(message: unknown, stackOrContext?: string, context?: string): void {
    this.write("error", message, context ?? stackOrContext, stackOrContext);
  }
  warn(message: unknown, context?: string): void {
    this.write("warn", message, context);
  }
  debug(message: unknown, context?: string): void {
    this.write("debug", message, context);
  }
  verbose(message: unknown, context?: string): void {
    this.write("verbose", message, context);
  }
}

/** Render any log subject to a string, preserving Error messages/stacks. */
function stringifyMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof Error) return `${message.message}\n${message.stack ?? ""}`;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}
