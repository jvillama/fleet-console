import type { FastifyInstance } from "fastify";
import { streamContainerLogs } from "../docker.js";
import { auditFailOpen } from "./auth.js";

const MAX_LINE_CHARS = 8192;

/** WS close reasons are limited to 123 bytes on the wire. */
function closeReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : "log stream failed";
  return msg.slice(0, 120);
}

/**
 * Cross-Site WebSocket Hijacking guard. Browsers always send Origin on a
 * WS handshake; SameSite=Strict already keeps the session cookie off
 * cross-site upgrades, so this is defense-in-depth. Requests without an
 * Origin header (curl, wscat, tests) pass — they are not browsers and
 * cannot ride a victim's cookie jar.
 */
export function sameOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (origin === undefined) return true;
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Splits a chunked byte stream into lines. Strips a trailing \r per line,
 * truncates lines over MAX_LINE_CHARS, and force-flushes an over-long
 * buffer so a newline-free stream cannot grow memory unbounded.
 */
export function createLineForwarder(send: (line: string) => void): {
  push: (chunk: Buffer | string) => void;
  flush: () => void;
} {
  let buffer = "";
  const emit = (line: string): void => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    send(trimmed.slice(0, MAX_LINE_CHARS));
  };
  return {
    push(chunk) {
      buffer += chunk.toString();
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        emit(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE_CHARS) {
        emit(buffer);
        buffer = "";
      }
    },
    flush() {
      if (buffer.length > 0) emit(buffer);
      buffer = "";
    },
  };
}

/** Bytes of queued frames at which we stop sending. */
const HIGH_WATER = 1024 * 1024;
/** …and the mark the queue must drain back under before we resume. */
const LOW_WATER = 256 * 1024;

/** The slice of a WebSocket the send gate needs. */
interface SendTarget {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send: (data: string) => void;
}

/**
 * Bounds the memory one slow client can cost us. `socket.send()` never
 * blocks — ws queues the frame and reports the backlog in bufferedAmount —
 * so a container logging faster than a client drains grows that queue
 * without limit. At or above HIGH_WATER we stop sending and count the loss;
 * once the queue drains under LOW_WATER we resume and report the gap
 * in-band. Two marks rather than one: a client hovering at a single
 * threshold would emit a notice on nearly every line.
 *
 * Lossy by design. The panel keeps only the last 2000 lines, so frames a
 * far-behind client would discard on arrival aren't worth the memory.
 */
export function createSendGate(socket: SendTarget): {
  send: (line: string) => void;
  finish: () => void;
} {
  let dropped = 0;
  let suppressed = false;

  return {
    send(line) {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount >= (suppressed ? LOW_WATER : HIGH_WATER)) {
        suppressed = true;
        dropped += 1;
        return;
      }
      suppressed = false;
      if (dropped > 0) {
        socket.send(`⚠ ${dropped} lines dropped (slow client)`);
        dropped = 0;
      }
      socket.send(line);
    },
    finish() {
      if (dropped === 0) return;
      if (socket.readyState !== socket.OPEN) return;
      socket.send(`⚠ ${dropped} lines dropped (slow client)`);
      dropped = 0;
      suppressed = false;
    },
  };
}

/** Concurrent log streams a single user may hold open at once. */
const MAX_STREAMS_PER_USER = 5;

/**
 * Per-user cap on open log streams. createSendGate bounds what one stream
 * can cost us (1 MiB of queued frames); this bounds how many of those one
 * user can hold, so aggregate exposure is roster × cap × 1 MiB rather than
 * something that grows with connection count.
 *
 * tryAcquire hands back a release closure rather than exposing a
 * release(key) method: a caller cannot free a slot it never took, and the
 * closure guards its own idempotency, so the route can wire release to
 * several teardown paths without double-counting. Counts are deleted at
 * zero, so the map tracks users currently streaming rather than everyone
 * who ever has.
 *
 * One registry per Fastify instance — created in logsRoutes, never module
 * scope. A module-level counter survives across test files and would fail
 * the next file's first open.
 */
export function createStreamRegistry(): {
  tryAcquire: (key: string) => (() => void) | null;
  /** Keys with at least one open stream; lets tests prove slots are freed. */
  readonly size: number;
} {
  const open = new Map<string, number>();

  return {
    get size() {
      return open.size;
    },
    tryAcquire(key) {
      const count = open.get(key) ?? 0;
      if (count >= MAX_STREAMS_PER_USER) return null;
      open.set(key, count + 1);

      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = open.get(key) ?? 0;
        if (current <= 1) open.delete(key);
        else open.set(key, current - 1);
      };
    },
  };
}

/**
 * Live container logs over WebSocket. Session required via the global gate
 * (the cookie rides the upgrade request). One fail-open audit event per
 * stream open. Works for stopped containers too — the historical tail is
 * served and the stream then ends.
 */
export function logsRoutes(app: FastifyInstance): void {
  // Per Fastify instance, not module scope: tests build a fresh app per
  // case, and a module-level counter would survive across them.
  const streams = createStreamRegistry();

  app.get<{ Params: { id: string } }>(
    "/api/logs/:id",
    { websocket: true },
    async (socket, request) => {
      const { id } = request.params;

      // Same pattern as the stats route: ids are hex, names alnum ._- .
      if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
        socket.close(1008, "Invalid container id");
        return;
      }

      // The gate guarantees a session before this handler runs.
      const user = request.session.get("user");

      if (!sameOrigin(request.headers.origin, request.headers.host)) {
        auditFailOpen(request, {
          actor: user?.username ?? "unknown",
          role: user?.role ?? null,
          action: "container.logs",
          outcome: "failure",
          target: id,
          ip: request.ip,
          detail: `cross-origin websocket rejected: ${request.headers.origin ?? ""}`.slice(0, 200),
        });
        socket.close(1008, "Origin not allowed");
        return;
      }

      const release = streams.tryAcquire(user?.username ?? request.ip);
      if (release === null) {
        auditFailOpen(request, {
          actor: user?.username ?? "unknown",
          role: user?.role ?? null,
          action: "container.logs",
          outcome: "failure",
          target: id,
          ip: request.ip,
          detail: `concurrent log stream limit reached (${MAX_STREAMS_PER_USER})`,
        });
        socket.close(
          1013,
          `Too many concurrent log streams (max ${MAX_STREAMS_PER_USER})`,
        );
        return;
      }
      // Covers every normal teardown — client disconnect, stream end (1000),
      // stream error (1011). The two explicit release() calls below cover the
      // paths where "close" may already have fired and will never fire again.
      // release() is idempotent, so the overlap is harmless.
      socket.on("close", release);

      let logs;
      try {
        logs = await streamContainerLogs(id, { tail: 200 });
      } catch (err) {
        release();
        auditFailOpen(request, {
          actor: user?.username ?? "unknown",
          role: user?.role ?? null,
          action: "container.logs",
          outcome: "failure",
          target: id,
          ip: request.ip,
          detail: closeReason(err),
        });
        socket.close(1011, closeReason(err));
        return;
      }

      auditFailOpen(request, {
        actor: user?.username ?? "unknown",
        role: user?.role ?? null,
        action: "container.logs",
        outcome: "success",
        target: id,
        ip: request.ip,
      });

      if (socket.readyState !== socket.OPEN) {
        // Client vanished while the stream was opening.
        release();
        logs.close();
        return;
      }

      const gate = createSendGate(socket);
      const forwarder = createLineForwarder((line) => gate.send(line));
      logs.stream.on("data", (chunk: Buffer) => forwarder.push(chunk));
      logs.stream.on("end", () => {
        forwarder.flush();
        gate.finish();
        socket.close(1000, "stream ended");
      });
      logs.stream.on("error", (err: Error) => {
        // Deliberately not calling gate.finish() here: the 1011 close reason
        // already tells the client the stream failed, which is more useful
        // than a pending drop count on a connection that's closing anyway.
        socket.close(1011, closeReason(err));
      });
      socket.on("close", () => logs.close());
    },
  );
}
