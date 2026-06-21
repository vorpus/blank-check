import { type FastifyReply } from "fastify";

/**
 * The ONE SSE responder (doc 01 §7.2, charter §4.3). Every server-sent stream —
 * order tracking, generation swaps — frames events through this so the wire
 * framing (`id:` = seq, `event:` = type, `data:` = JSON) is defined exactly once.
 * Owns the raw response: sets the SSE headers, writes frames + heartbeats, and
 * runs a single cleanup on disconnect (the caller passes the unsubscribe).
 *
 * DRY: order streams, the Last-Event-ID replay, and the generation stream all
 * write through `send()` — no copy-pasted `res.raw.write("id: …")` anywhere.
 */
export class SseResponder {
  private heartbeat: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly reply: FastifyReply,
    private readonly onClose: () => void | Promise<void>,
    heartbeatMs = 15_000,
  ) {
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // disable proxy buffering so frames flush immediately
    });
    // Open the stream with a comment so the client's connection settles.
    raw.write(": stream open\n\n");

    // Heartbeat comments keep intermediaries from idling the connection out and
    // let the server notice a dead socket.
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      raw.write(": ping\n\n");
    }, heartbeatMs);

    // Clean unsubscribe on disconnect — no Redis subscriber leak (the caller's
    // onClose tears down its pub/sub subscription).
    const cleanup = (): void => void this.close();
    raw.on("close", cleanup);
    raw.on("error", cleanup);
  }

  /**
   * Frame one event per the §4.3 SSE contract. `id` is the per-order `seq` (so the
   * browser's EventSource sends it back as `Last-Event-ID` on reconnect); `event`
   * is the event type; `data` is the JSON body.
   */
  send(event: { id?: number; type: string; data: unknown }): void {
    if (this.closed) return;
    const raw = this.reply.raw;
    if (event.id !== undefined) raw.write(`id: ${String(event.id)}\n`);
    raw.write(`event: ${event.type}\n`);
    raw.write(`data: ${JSON.stringify(event.data)}\n\n`);
  }

  /** Idempotent teardown: stop the heartbeat, run onClose, end the response. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    try {
      await this.onClose();
    } finally {
      if (!this.reply.raw.writableEnded) this.reply.raw.end();
    }
  }
}
