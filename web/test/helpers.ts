import { vi } from "vitest";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

/** A promise the test resolves manually — for busy states and race tests. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export type Route =
  | Response
  | ((url: string, init?: RequestInit) => Response | Promise<Response>)
  | object;

/**
 * Installs a global fetch stub. Routes match by URL prefix, first match
 * wins — beware overlapping prefixes: they resolve in insertion order, so
 * list most-specific first (e.g. "/api/containers/x/stats" before
 * "/api/containers", or the list route swallows the stats request).
 * Plain objects are wrapped in a fresh 200 JSON Response on every
 * call (safe for polling); a raw Response is one-shot (its body can only
 * be read once); a function gets full control (deferred responses, per-call
 * status changes). Unmatched URLs throw, failing the test loudly.
 */
export function stubFetch(routes: Record<string, Route>): {
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, init });
      const entry = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
      if (!entry) throw new Error(`stubFetch: no route for ${url}`);
      const route = entry[1];
      if (typeof route === "function") {
        return (route as (u: string, i?: RequestInit) => Response | Promise<Response>)(url, init);
      }
      if (route instanceof Response) return route;
      return jsonResponse(route);
    }),
  );
  return { calls };
}

type Handler<E> = ((event: E) => void) | null;

/**
 * Stand-in for the browser WebSocket, driven by the test via fire*().
 * Matches the property-handler style (socket.onopen = ...) LogPanel uses.
 */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState: number = FakeWebSocket.CONNECTING;
  onopen: Handler<Event> = null;
  onmessage: Handler<MessageEvent> = null;
  onclose: Handler<CloseEvent> = null;
  onerror: Handler<Event> = null;
  send = vi.fn();
  close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = FakeWebSocket.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  fireMessage(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  fireClose(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

/** Clears the registry and installs FakeWebSocket as the global WebSocket. */
export function installFakeWebSocket(): typeof FakeWebSocket {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  return FakeWebSocket;
}
