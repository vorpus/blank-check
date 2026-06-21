/**
 * The minimal injectable `EventSource` surface the TrackingClient needs
 * (doc 05 §5.1). The browser's global `EventSource` satisfies this structurally;
 * Stage 6 mobile injects a React-Native polyfill (e.g. `react-native-sse`). The
 * SDK never references the DOM global directly, so nothing browser-specific leaks
 * into the platform-agnostic surface.
 */

/** One SSE frame as delivered to a listener (`MessageEvent`-compatible subset). */
export interface SseMessageEvent {
  /** The `data:` payload (JSON text in our framing). */
  readonly data: string;
  /** The `id:` line — the event `seq` (doc 05 §4.3). */
  readonly lastEventId: string;
}

/** Structural subset of the DOM `EventSource` we depend on. */
export interface SseConnection {
  /** Listen for a named server event (`event:` line), e.g. `tracking_event`. */
  addEventListener(type: string, listener: (ev: SseMessageEvent) => void): void;
  /** Default (`message`) and error channels. */
  onmessage: ((ev: SseMessageEvent) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  /** Stop the stream and release the socket. */
  close(): void;
}

/** Per-connection options (mirrors the DOM `EventSourceInit` we use). */
export interface SseInit {
  withCredentials?: boolean;
}

/**
 * The injectable factory. `(url, init) => SseConnection`. The DOM
 * `EventSource` constructor is assignable to this; a polyfill supplies its own.
 * Bearer auth rides as a `?token=` query param because EventSource cannot set an
 * `Authorization` header (the api's SSE auth convention — orders.controller §3b).
 */
export type EventSourceFactory = (url: string, init?: SseInit) => SseConnection;
