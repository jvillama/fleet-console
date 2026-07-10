# Live Log Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click a container row on the dashboard and watch its logs live in a slide-over panel — WebSocket transport, last 200 lines backfilled, every stream open audited.

**Architecture:** A `@fastify/websocket` route at `GET /api/logs/:id` sits behind the existing session gate (the cookie rides the upgrade request — no new auth code). `docker.ts` stays the only dockerode module and gains `streamContainerLogs()`, which demuxes Docker's multiplexed framing for non-TTY containers. The route splits the stream into per-line text frames. The SPA gets a `LogPanel` slide-over with pinned auto-scroll and a capped buffer.

**Tech Stack:** Fastify 5, `@fastify/websocket` 11 (handler signature `(socket, request)`; tests use `app.injectWS`), dockerode `container.logs({follow: true})` + `docker.modem.demuxStream`, React 18, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-09-log-streaming-design.md`

## Global Constraints

- Two independent npm packages — run every npm command inside `server/` or `web/`, never at the repo root.
- Server is Node 22 ESM with NodeNext resolution: **relative imports must end in `.js`** (e.g. `./docker.js`) even though sources are `.ts`. Web uses bundler resolution: extensionless imports.
- Server tsconfig has `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` — never assign `undefined` to an optional property; build objects conditionally.
- `src/docker.ts` stays the only module touching dockerode; `src/audit.ts` the only module touching better-sqlite3; `src/auth.ts` the only module reading user config / verifying passwords.
- The Docker socket mount stays **read-only** (`:ro`). Log streaming is a read; no mutating endpoints.
- Audit policy: fail-open in this slice (log the error, let the stream proceed). One audit event per stream open — `action: "container.logs"`, `target: <container id>` — not per line.
- Tests must not need a Docker daemon or a real filesystem (audit DB stays `:memory:`; dockerode is mocked).
- `server/src/types.ts` / `web/src/types.ts` are hand-mirrored — **this plan changes neither** (log frames are plain text).
- Commit messages: conventional prefix (`feat:`/`test:`/`docs:`), **no Co-Authored-By trailer**.
- The existing 63 server tests must keep passing at the end of every task.

---

### Task 1: Docker seam — `streamContainerLogs()`

**Files:**
- Modify: `server/src/docker.ts` (append)
- Test: `server/test/docker.test.ts` (append; extend the hoisted mock)

**Interfaces:**
- Consumes: the module-level `docker` client already in `docker.ts`.
- Produces (Task 2 relies on these exact signatures):
  - `interface LogStream { stream: NodeJS.ReadableStream; close: () => void }`
  - `streamContainerLogs(id: string, opts: { tail: number }): Promise<LogStream>`

- [ ] **Step 1: Extend the dockerode mock in `server/test/docker.test.ts`**

The hoisted `mockClient` at the top of the file needs a `modem`. Replace the existing `vi.hoisted` block with:

```ts
const mockClient = vi.hoisted(() => ({
  listContainers: vi.fn(),
  getContainer: vi.fn(),
  version: vi.fn(),
  info: vi.fn(),
  ping: vi.fn(),
  modem: { demuxStream: vi.fn() },
}));
```

Add `PassThrough` to the imports at the top of the file:

```ts
import { PassThrough } from "node:stream";
```

and add `streamContainerLogs` to the import from `../src/docker.js`.

- [ ] **Step 2: Write the failing tests**

Append to `server/test/docker.test.ts`:

```ts
describe("streamContainerLogs", () => {
  function mockLogsContainer(tty: boolean) {
    const source = new PassThrough();
    const logs = vi.fn().mockResolvedValue(source);
    mockClient.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Config: { Tty: tty } }),
      logs,
    });
    return { source, logs };
  }

  it("passes the raw stream through for TTY containers and forwards options", async () => {
    const { source, logs } = mockLogsContainer(true);

    const result = await streamContainerLogs("abc123", { tail: 200 });

    expect(logs).toHaveBeenCalledWith({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 200,
    });
    expect(mockClient.modem.demuxStream).not.toHaveBeenCalled();

    const chunks: string[] = [];
    result.stream.on("data", (c: Buffer) => chunks.push(c.toString()));
    source.write("hello\n");
    await new Promise((r) => setImmediate(r));
    expect(chunks.join("")).toBe("hello\n");
  });

  it("demuxes non-TTY containers into one plain stream", async () => {
    const { source } = mockLogsContainer(false);
    // Simulate docker-modem: forward the source into the stdout writable.
    mockClient.modem.demuxStream.mockImplementation(
      (src: NodeJS.ReadableStream, out: NodeJS.WritableStream) => {
        src.on("data", (c: Buffer) => out.write(c));
      },
    );

    const result = await streamContainerLogs("abc123", { tail: 200 });

    expect(mockClient.modem.demuxStream).toHaveBeenCalledTimes(1);
    expect(mockClient.modem.demuxStream.mock.calls[0]?.[0]).toBe(source);

    const chunks: string[] = [];
    result.stream.on("data", (c: Buffer) => chunks.push(c.toString()));
    source.write("demuxed line\n");
    await new Promise((r) => setImmediate(r));
    expect(chunks.join("")).toBe("demuxed line\n");
  });

  it("ends the demuxed stream when the source ends", async () => {
    const { source } = mockLogsContainer(false);
    mockClient.modem.demuxStream.mockImplementation(() => {});

    const result = await streamContainerLogs("abc123", { tail: 200 });
    const ended = new Promise<void>((resolve) =>
      result.stream.on("end", () => resolve()),
    );
    result.stream.on("data", () => {}); // start flowing so "end" can fire
    source.end();
    await ended; // test fails by timeout if end never propagates
  });

  it("close() destroys the underlying source stream", async () => {
    const { source } = mockLogsContainer(true);

    const result = await streamContainerLogs("abc123", { tail: 200 });
    result.close();

    expect(source.destroyed).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (in `server/`): `npm test -- test/docker.test.ts`
Expected: FAIL — `streamContainerLogs` is not exported.

- [ ] **Step 4: Implement in `server/src/docker.ts`**

Add to the imports at the top:

```ts
import { PassThrough } from "node:stream";
```

Append at the end of the file:

```ts
export interface LogStream {
  stream: NodeJS.ReadableStream;
  close: () => void;
}

/**
 * Live log stream for one container: last `tail` lines, then follow.
 * TTY containers emit plain text; non-TTY containers use Docker's
 * multiplexed framing, which is demuxed here so callers always get text.
 * close() destroys the daemon connection so it stops following.
 */
export async function streamContainerLogs(
  id: string,
  opts: { tail: number },
): Promise<LogStream> {
  const container = docker.getContainer(id);
  const info = await container.inspect();
  const source = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail: opts.tail,
  });

  const close = (): void => {
    (source as unknown as { destroy?: () => void }).destroy?.();
  };

  if (info.Config.Tty) {
    return { stream: source, close };
  }

  const demuxed = new PassThrough();
  docker.modem.demuxStream(source, demuxed, demuxed);
  source.on("end", () => demuxed.end());
  source.on("error", (err) => demuxed.destroy(err as Error));
  return { stream: demuxed, close };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (in `server/`): `npm test -- test/docker.test.ts`
Expected: PASS (existing docker tests + 4 new).

- [ ] **Step 6: Typecheck + full suite + commit**

Run (in `server/`): `npm run typecheck` then `npm test` — all green (67 tests).

```bash
git add server/src/docker.ts server/test/docker.test.ts
git commit -m "feat: add streamContainerLogs to the docker seam"
```

---

### Task 2: WebSocket route `GET /api/logs/:id`

**Files:**
- Modify: `server/package.json` (deps via npm install)
- Modify: `server/src/routes/auth.ts` (export the fail-open audit helper)
- Create: `server/src/routes/logs.ts`
- Modify: `server/src/app.ts` (register plugin + route)
- Modify: `server/test/routes.test.ts` (add `streamContainerLogs` to the docker mock)
- Test: `server/test/logs-routes.test.ts`

**Interfaces:**
- Consumes: `streamContainerLogs`, `LogStream` (Task 1); `recordEvent`/`NewAuditEvent` via the auth helper; `loginAs` (existing test helper); session gate (existing).
- Produces:
  - `logsRoutes(app: FastifyInstance): Promise<void>` registering the WS route
  - `auditFailOpen(request: FastifyRequest, event: NewAuditEvent): void` exported from `server/src/routes/auth.ts`
  - Wire behavior Task 3's panel relies on: per-line text frames; close codes `1000 "stream ended"`, `1008 "Invalid container id"`, `1011 <error>`.

- [ ] **Step 1: Install dependencies**

Run (in `server/`):

```bash
npm install @fastify/websocket
npm install -D @types/ws
```

(`@fastify/websocket` may already be present from planning; the commands are idempotent. `ws` itself comes with the plugin; `@types/ws` is needed because the plugin's types and our tests reference the `ws` WebSocket type.)

- [ ] **Step 2: Export the fail-open audit helper from `server/src/routes/auth.ts`**

The private `audit()` helper at the top of that file becomes a named export so the logs route reuses it instead of duplicating the policy. Change:

```ts
function audit(request: FastifyRequest, event: NewAuditEvent): void {
```

to:

```ts
export function auditFailOpen(request: FastifyRequest, event: NewAuditEvent): void {
```

and update the three call sites inside `authRoutes` (`audit(request, {...})` → `auditFailOpen(request, {...})`). The doc comment above it stays.

- [ ] **Step 3: Write the failing tests**

Create `server/test/logs-routes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";

vi.mock("../src/docker.js", () => ({
  getContainerStats: vi.fn(),
  getFleetOverview: vi.fn(),
  listContainers: vi.fn(),
  pingDocker: vi.fn(),
  streamContainerLogs: vi.fn(),
}));

import * as dockerApi from "../src/docker.js";
import { buildApp } from "../src/app.js";
import { queryEvents } from "../src/audit.js";
import { loginAs } from "./helpers.js";

const mocked = vi.mocked(dockerApi);

let app: FastifyInstance;
let cookies: { session: string };

beforeEach(async () => {
  vi.resetAllMocks();
  app = await buildApp();
  cookies = await loginAs(app);
});

afterEach(async () => {
  await app.close();
});

function mockLogStream() {
  const stream = new PassThrough();
  const close = vi.fn(() => stream.destroy());
  mocked.streamContainerLogs.mockResolvedValue({ stream, close });
  return { stream, close };
}

function openSocket(id = "abc123") {
  return app.injectWS(`/api/logs/${id}`, {
    headers: { cookie: `session=${cookies.session}` },
  });
}

function onClose(ws: Awaited<ReturnType<typeof openSocket>>) {
  return new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
}

function auditPage() {
  return queryEvents({ limit: 10, offset: 0, action: "container.logs" });
}

describe("GET /api/logs/:id (websocket)", () => {
  it("rejects an unauthenticated upgrade and writes no audit row", async () => {
    mockLogStream();

    await expect(app.injectWS("/api/logs/abc123")).rejects.toThrow();

    expect(auditPage().total).toBe(0);
    expect(mocked.streamContainerLogs).not.toHaveBeenCalled();
  });

  it("closes 1008 on an invalid id without touching Docker", async () => {
    mockLogStream();

    const ws = await openSocket("bad$id");
    const closed = await onClose(ws);

    expect(closed).toEqual({ code: 1008, reason: "Invalid container id" });
    expect(mocked.streamContainerLogs).not.toHaveBeenCalled();
    expect(auditPage().total).toBe(0);
  });

  it("audits the stream open with actor, target, and ip", async () => {
    mockLogStream();

    const ws = await openSocket();
    await vi.waitFor(() => expect(auditPage().total).toBe(1));

    expect(auditPage().events[0]).toMatchObject({
      actor: "alice",
      role: "admin",
      action: "container.logs",
      target: "abc123",
      outcome: "success",
    });
    expect(auditPage().events[0]?.ip).toBeTruthy();
    ws.close();
  });

  it("forwards log chunks as one text frame per line", async () => {
    const { stream } = mockLogStream();
    const ws = await openSocket();
    const messages: string[] = [];
    ws.on("message", (data) => messages.push(data.toString()));

    stream.write("first line\nsecond ");
    stream.write("line\n");

    await vi.waitFor(() =>
      expect(messages).toEqual(["first line", "second line"]),
    );
    ws.close();
  });

  it("strips trailing carriage returns and truncates monster lines", async () => {
    const { stream } = mockLogStream();
    const ws = await openSocket();
    const messages: string[] = [];
    ws.on("message", (data) => messages.push(data.toString()));

    stream.write("crlf line\r\n");
    stream.write(`${"x".repeat(9000)}\n`);

    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[0]).toBe("crlf line");
    expect(messages[1]).toHaveLength(8192);
    ws.close();
  });

  it("flushes the partial tail and closes 1000 when the stream ends", async () => {
    const { stream } = mockLogStream();
    const ws = await openSocket();
    const messages: string[] = [];
    ws.on("message", (data) => messages.push(data.toString()));
    const closed = onClose(ws);

    stream.write("no trailing newline");
    stream.end();

    expect(await closed).toEqual({ code: 1000, reason: "stream ended" });
    expect(messages).toEqual(["no trailing newline"]);
  });

  it("closes 1011 with the message when the stream errors", async () => {
    const { stream } = mockLogStream();
    const ws = await openSocket();
    const closed = onClose(ws);
    await vi.waitFor(() => expect(auditPage().total).toBe(1)); // handler attached

    stream.destroy(new Error("daemon gone"));

    expect(await closed).toEqual({ code: 1011, reason: "daemon gone" });
  });

  it("closes 1011 and audits failure when the stream cannot open", async () => {
    mocked.streamContainerLogs.mockRejectedValue(new Error("no such container"));

    const ws = await openSocket("deadbeef");
    const closed = await onClose(ws);

    expect(closed).toEqual({ code: 1011, reason: "no such container" });
    expect(auditPage().events[0]).toMatchObject({
      target: "deadbeef",
      outcome: "failure",
    });
  });

  it("closes the docker stream when the client disconnects", async () => {
    const { close } = mockLogStream();
    const ws = await openSocket();
    await vi.waitFor(() => expect(auditPage().total).toBe(1)); // handler attached

    ws.close();

    await vi.waitFor(() => expect(close).toHaveBeenCalled());
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run (in `server/`): `npm test -- test/logs-routes.test.ts`
Expected: FAIL — `app.injectWS is not a function` (plugin not registered) or upgrade 404.

- [ ] **Step 5: Create `server/src/routes/logs.ts`**

```ts
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
```

- [ ] **Step 6: Register plugin and route in `server/src/app.ts`**

Add imports:

```ts
import websocket from "@fastify/websocket";
import { logsRoutes } from "./routes/logs.js";
```

Register the plugin immediately after the `rateLimit` registration:

```ts
  await app.register(websocket);
```

Register the route next to the others (after `auditRoutes`):

```ts
  await app.register(logsRoutes);
```

- [ ] **Step 7: Add `streamContainerLogs` to the docker mock in `server/test/routes.test.ts`**

The `vi.mock("../src/docker.js", ...)` factory at the top of that file lists the wrapper's functions; add one line so the mocked module stays shape-complete:

```ts
vi.mock("../src/docker.js", () => ({
  getContainerStats: vi.fn(),
  getFleetOverview: vi.fn(),
  listContainers: vi.fn(),
  pingDocker: vi.fn(),
  streamContainerLogs: vi.fn(),
}));
```

- [ ] **Step 8: Run the tests to verify they pass**

Run (in `server/`): `npm test -- test/logs-routes.test.ts` then `npm test`
Expected: the new suite passes (9 tests) and the full suite stays green.

- [ ] **Step 9: Typecheck + commit**

Run (in `server/`): `npm run typecheck` → no errors.

```bash
git add server/src/routes/logs.ts server/src/routes/auth.ts server/src/app.ts server/test/logs-routes.test.ts server/test/routes.test.ts server/package.json server/package-lock.json
git commit -m "feat: session-gated WebSocket log streaming at /api/logs/:id"
```

---

### Task 3: Slide-over log panel in the SPA

**Files:**
- Modify: `web/src/api.ts` (append helper)
- Create: `web/src/components/LogPanel.tsx`
- Modify: `web/src/components/FleetTable.tsx` (row click → onSelect)
- Modify: `web/src/App.tsx` (selected state, render panel)
- Modify: `web/src/styles.css` (append)

**Interfaces:**
- Consumes: the wire behavior from Task 2 (per-line text frames; close codes 1000/1008/1011); `ContainerSummary` (existing type).
- Produces: `LogPanel({ container, onClose })`; `FleetTable` gains a required `onSelect: (container: ContainerSummary) => void` prop; `logsSocketUrl(id: string): string` in `api.ts`.

- [ ] **Step 1: Append the URL helper to `web/src/api.ts`**

```ts
/** Same-origin WebSocket URL for a container's live log stream. */
export function logsSocketUrl(id: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/api/logs/${id}`;
}
```

- [ ] **Step 2: Create `web/src/components/LogPanel.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { logsSocketUrl } from "../api";
import type { ContainerSummary } from "../types";

const MAX_LINES = 2000;

type StreamStatus = "connecting" | "streaming" | "ended" | "disconnected";

export function LogPanel({
  container,
  onClose,
}: {
  container: ContainerSummary;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [reason, setReason] = useState<string | null>(null);
  const [pinned, setPinned] = useState(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLines([]);
    setStatus("connecting");
    setReason(null);
    setPinned(true);

    const socket = new WebSocket(logsSocketUrl(container.id));
    socket.onopen = () => setStatus("streaming");
    socket.onmessage = (event) => {
      setLines((prev) => {
        const next = [...prev, String(event.data)];
        return next.length > MAX_LINES
          ? next.slice(next.length - MAX_LINES)
          : next;
      });
    };
    socket.onclose = (event) => {
      setStatus(event.code === 1000 ? "ended" : "disconnected");
      if (event.reason) setReason(event.reason);
    };
    return () => socket.close();
  }, [container.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (pinned && scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [lines, pinned]);

  function handleScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 4);
  }

  return (
    <aside className="log-panel">
      <header className="log-header">
        <div>
          <span className="name">{container.name}</span>
          <span className="short-id">{container.shortId}</span>
        </div>
        <span className={`log-status log-status-${status}`}>
          {status}
          {reason ? ` — ${reason}` : ""}
        </span>
        <button className="log-close" onClick={onClose} aria-label="Close logs">
          ×
        </button>
      </header>
      <div className="log-lines" ref={scrollerRef} onScroll={handleScroll}>
        {lines.length === 0 && status !== "connecting" ? (
          <p className="log-empty">No log output.</p>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="log-line">
              {line}
            </div>
          ))
        )}
      </div>
      {!pinned && (
        <button className="log-jump" onClick={() => setPinned(true)}>
          ↓ Jump to latest
        </button>
      )}
    </aside>
  );
}
```

- [ ] **Step 3: Make rows selectable in `web/src/components/FleetTable.tsx`**

Change the component signature:

```tsx
export function FleetTable({
  containers,
  onSelect,
}: {
  containers: ContainerSummary[];
  onSelect: (container: ContainerSummary) => void;
}) {
```

and add the click handler to the row element:

```tsx
<tr
  key={c.id}
  className={c.state !== "running" ? "row-down" : ""}
  onClick={() => onSelect(c)}
>
```

Everything else in the file is unchanged.

- [ ] **Step 4: Wire the panel into `Console` in `web/src/App.tsx`**

Add to the imports:

```tsx
import { LogPanel } from "./components/LogPanel";
import type { ContainerSummary, SessionUser } from "./types";
```

(the file already imports `SessionUser`; merge into one type import.)

Inside `Console`, next to the `view` state:

```tsx
const [selected, setSelected] = useState<ContainerSummary | null>(null);
```

The Audit tab's onClick also closes the panel (spec: switching views closes it):

```tsx
onClick={() => {
  setView("audit");
  setSelected(null);
}}
```

Pass the selection handler to the table:

```tsx
<FleetTable containers={containers.data ?? []} onSelect={setSelected} />
```

and render the panel inside the dashboard branch, after `</main>` (still inside the fragment):

```tsx
{selected && (
  <LogPanel container={selected} onClose={() => setSelected(null)} />
)}
```

- [ ] **Step 5: Append styles to `web/src/styles.css`**

```css
/* Clickable fleet rows (open the log panel) */
.fleet tbody tr {
  cursor: pointer;
}

/* Log slide-over panel */
.log-panel {
  position: fixed;
  top: 0;
  right: 0;
  height: 100vh;
  width: 40vw;
  min-width: 480px;
  max-width: 90vw;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-left: 1px solid var(--line);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.35);
  z-index: 20;
}

.log-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
}

.log-header .name {
  display: block;
}

.log-status {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40%;
}

.log-status-streaming {
  color: var(--led-ok);
}

.log-status-disconnected {
  color: var(--led-down);
}

.log-close {
  background: none;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 2px 9px;
  color: var(--text-dim);
  font-size: 14px;
  cursor: pointer;
}

.log-close:hover {
  color: var(--text);
  border-color: var(--text-dim);
}

.log-lines {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px;
  background: var(--bg);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
}

.log-line {
  white-space: pre-wrap;
  word-break: break-all;
}

.log-empty {
  color: var(--text-dim);
}

.log-jump {
  position: absolute;
  bottom: 16px;
  right: 24px;
  background: var(--surface-raised);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 12px;
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 12px;
  cursor: pointer;
}
```

- [ ] **Step 6: Typecheck + build**

Run (in `web/`): `npm run typecheck` then `npm run build`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add web/src/api.ts web/src/components/LogPanel.tsx web/src/components/FleetTable.tsx web/src/App.tsx web/src/styles.css
git commit -m "feat: live log slide-over panel in the SPA"
```

---

### Task 4: Proxy WebSocket upgrades + docs

**Files:**
- Modify: `web/nginx.conf`
- Modify: `web/vite.config.ts`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the WS route (Task 2) and panel (Task 3).
- Produces: WS upgrades work through both the compose nginx and the Vite dev proxy; docs describe the feature.

- [ ] **Step 1: Replace `web/nginx.conf`**

```nginx
# WebSocket upgrades (live log streaming): Connection header must be
# "upgrade" during a handshake and unset otherwise. conf.d files are
# included at http context, so map is legal here.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      "";
}

server {
    listen 80;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Same-origin API: the browser only ever talks to this nginx, which
    # forwards /api to the server container on the compose network.
    location /api/ {
        proxy_pass http://server:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        # Log streams are long-lived and can be quiet between lines; the
        # 60s default would sever idle streams.
        proxy_read_timeout 1h;
    }
}
```

- [ ] **Step 2: Enable WS proxying in `web/vite.config.ts`**

In the `"/api"` proxy entry, add `ws: true`:

```ts
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://localhost:4000",
        changeOrigin: true,
        ws: true,
      },
    },
```

- [ ] **Step 3: Update `README.md`**

1. API table — add this row at the bottom (after the `/api/audit` row):

```markdown
| `WS /api/logs/:id` | session | Live container log stream (tail 200, then follow) |
```

2. In the "Authentication & audit log" section, the sentence starting "Every login, failed login, and logout is recorded" becomes:

```markdown
Every login, failed login, logout, and log-stream open is recorded in a
SQLite audit log
```

(rest of the sentence unchanged).

3. Roadmap — insert a new checked line between Phase 1.5 and Phase 2, and trim log streaming out of the Phase 2 line:

```markdown
- [x] **Phase 1.75 — live logs:** per-container log streaming over WebSockets, session-gated and audited
- [ ] **Phase 2 — actions:** start/stop/restart from the UI; socket mounted `rw`; role enforcement; mutating actions audited **fail-closed**
```

- [ ] **Step 4: Update `CLAUDE.md`**

Append one gotcha:

```markdown
- `GET /api/logs/:id` is a WebSocket route (`@fastify/websocket`); the session gate covers the upgrade request. In tests, drive it with `app.injectWS(path, { headers: { cookie: \`session=${cookies.session}\` } })` — see `test/logs-routes.test.ts`. The nginx and Vite proxies are WS-aware; if you add another WS route, no proxy changes are needed.
```

- [ ] **Step 5: Verify + commit**

- Run (in `server/`): `npm run typecheck && npm test` — green.
- Run (in `web/`): `npm run typecheck && npm run build` — green.

```bash
git add web/nginx.conf web/vite.config.ts README.md CLAUDE.md
git commit -m "feat: proxy WebSocket upgrades and document live log streaming"
```

---

### Task 5: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full server + web check**

Run (in `server/`): `npm run typecheck && npm test && npm run build`
Run (in `web/`): `npm run typecheck && npm run build`
Expected: all green (server: 63 pre-existing + 13 new = 76 tests).

- [ ] **Step 2: Compose smoke test (requires a Docker daemon; controller runs it)**

From the repo root, with `FLEET_SESSION_SECRET` and `FLEET_USERS` exported as in the auth smoke test:

```bash
docker compose up --build -d
# login and capture the cookie
curl -s -c /tmp/fc-cookies.txt -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"<pw>"}' http://localhost:8080/api/login
# pick a running container id
curl -s -b /tmp/fc-cookies.txt http://localhost:8080/api/containers | head -c 400
```

Then verify the WS path end-to-end through nginx with the `ws` package (available under `server/node_modules`):

```bash
SESSION=$(grep -oP 'session\s+\K\S+' /tmp/fc-cookies.txt) \
CONTAINER_ID=<id from the previous step> \
node --input-type=module -e "
import WebSocket from './server/node_modules/ws/wrapper.mjs';
const ws = new WebSocket(\`ws://localhost:8080/api/logs/\${process.env.CONTAINER_ID}\`, {
  headers: { cookie: \`session=\${process.env.SESSION}\` },
});
ws.on('message', (d) => { console.log('FRAME:', d.toString().slice(0, 120)); ws.close(); });
ws.on('close', (c, r) => { console.log('CLOSE:', c, r.toString()); process.exit(0); });
ws.on('error', (e) => { console.error('ERROR:', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT: no frame'); process.exit(1); }, 15000);
"
```

Expected: at least one `FRAME:` line. Also confirm `GET /api/audit?action=container.logs` (with the cookie) shows the stream-open event. `docker compose down` afterwards.

- [ ] **Step 3: Push and finish**

Push the branch, open the PR, watch CI, then use superpowers:finishing-a-development-branch.
