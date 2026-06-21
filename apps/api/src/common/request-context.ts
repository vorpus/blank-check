import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped context propagated via AsyncLocalStorage (doc 01 §12 — "structured
 * logging with propagated requestId"). The HTTP layer seeds `requestId` per
 * request; the logger and the ErrorEnvelope filter read it so every log line and
 * error response carries the same correlation id without threading it by hand.
 */
export interface RequestContext {
  requestId: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  /** Bind the store to the current async context (for hook-based seeding). */
  enterWith(ctx: RequestContext): void {
    storage.enterWith(ctx);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
  requestId(): string {
    return storage.getStore()?.requestId ?? "no-request-id";
  },
  setUserId(userId: string): void {
    const ctx = storage.getStore();
    if (ctx) ctx.userId = userId;
  },
};
