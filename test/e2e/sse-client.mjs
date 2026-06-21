// Minimal SSE-over-fetch client for the E2E (no EventSource in node:22 runtime,
// and the SDK's TrackingClient injects an EventSourceFactory we don't need here).
// Parses `id:` / `event:` / `data:` frames from a streaming fetch body and lets
// the caller deterministically ABORT the connection (to prove the polling
// fallback). Carries the resume cursor as `?lastEventId=` on connect — the exact
// path the SSE fix (read query OR header) closes.

/**
 * Open an SSE stream and invoke `onEvent({ id, event, data })` per frame.
 * Returns `{ abort, done }` — `abort()` kills the socket; `done` resolves when
 * the stream ends or is aborted.
 */
export function openSse(url, { onEvent, headers = {} } = {}) {
  const ac = new AbortController();
  const done = (async () => {
    let res;
    try {
      res = await fetch(url, { headers: { accept: "text/event-stream", ...headers }, signal: ac.signal });
    } catch (err) {
      if (ac.signal.aborted) return;
      throw err;
    }
    if (!res.ok || !res.body) throw new Error(`SSE connect failed: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.startsWith(":")) continue; // comment / heartbeat
          const id = (frame.match(/^id: (.*)$/m) || [])[1];
          const event = (frame.match(/^event: (.*)$/m) || [])[1];
          const dataLine = (frame.match(/^data: (.*)$/m) || [])[1];
          if (!event) continue;
          let data;
          try {
            data = dataLine ? JSON.parse(dataLine) : undefined;
          } catch {
            continue;
          }
          onEvent({ id: id !== undefined ? Number(id) : undefined, event, data });
        }
      }
    } catch (err) {
      if (!ac.signal.aborted) throw err;
    }
  })();
  return { abort: () => ac.abort(), done };
}
