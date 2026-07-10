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

/**
 * Live container logs over WebSocket. Session required via the global gate
 * (the cookie rides the upgrade request). One fail-open audit event per
 * stream open. Works for stopped containers too — the historical tail is
 * served and the stream then ends.
 */
export async function logsRoutes(app: FastifyInstance): Promise<void> {
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

      let logs;
      try {
        logs = await streamContainerLogs(id, { tail: 200 });
      } catch (err) {
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
        logs.close();
        return;
      }

      const forwarder = createLineForwarder((line) => {
        if (socket.readyState === socket.OPEN) socket.send(line);
      });
      logs.stream.on("data", (chunk: Buffer) => forwarder.push(chunk));
      logs.stream.on("end", () => {
        forwarder.flush();
        socket.close(1000, "stream ended");
      });
      logs.stream.on("error", (err: Error) => {
        socket.close(1011, closeReason(err));
      });
      socket.on("close", () => logs.close());
    },
  );
}
