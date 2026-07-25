# WebSocket Log-Stream Backpressure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the per-socket memory a slow log-stream client can cost the
server, by dropping lines when the send queue is deep and reporting the gap
in-band when it drains.

**Architecture:** A new exported factory `createSendGate(socket)` in
`server/src/routes/logs.ts` wraps `socket.send`, watching
`socket.bufferedAmount`. It sits between the existing `createLineForwarder`
and the socket. Two thresholds give hysteresis. Nothing else in the
codebase changes — not `docker.ts`, not `types.ts`, not the web package.

**Tech Stack:** TypeScript (NodeNext), Fastify 5, `@fastify/websocket` /
`ws`, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-24-ws-backpressure-design.md`

## Global Constraints

- Work on branch `ws-backpressure` (already checked out; the spec commit
  `fa17adb` is its tip).
- Run all npm commands **inside `server/`**. There are no workspaces; the
  repo root has no package.json.
- Server uses **NodeNext** module resolution: every relative import must
  end in `.js` even though sources are `.ts` (e.g. `../src/routes/logs.js`).
- **No dependency changes.** No `package.json` edit, therefore no lockfile
  regeneration (the repo has an npm-10 lockfile gotcha; avoid triggering it).
- **No `server/src/types.ts` change.** The API contract is unchanged, so
  `scripts/sync-types.mjs` must not run and CI's `contract` job is unaffected.
- **`server/test/logs-routes.test.ts` must not be edited.** Its existing
  assertions are the proof that the gate did not alter normal-path
  behavior. If a change there seems necessary, the implementation is wrong —
  stop and report.
- Exact notice text, one line, no trailing punctuation:
  `⚠ ${dropped} lines dropped (slow client)` — the `⚠` is U+26A0 followed by
  a space. Files are UTF-8.
- Thresholds, exact values: `HIGH_WATER = 1024 * 1024`,
  `LOW_WATER = 256 * 1024`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `server/src/routes/logs.ts` | Modify | Adds `SendTarget`, `HIGH_WATER`, `LOW_WATER`, `createSendGate`; wires the gate into the route handler |
| `server/test/logs-send-gate.test.ts` | Create | Unit tests for `createSendGate` against a fake socket — no Fastify, no WebSocket, no docker mock |
| `README.md` | Modify | One paragraph documenting the drop behavior |

`logs.ts` is ~150 lines and already holds two exported helpers
(`sameOrigin`, `createLineForwarder`) tested from outside. A third fits the
established shape; no split is warranted.

---

## Task 1: The send gate — drop and resume

**Files:**
- Modify: `server/src/routes/logs.ts` (add after `createLineForwarder`, ~line 66)
- Test: `server/test/logs-send-gate.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface SendTarget { readonly readyState: number; readonly OPEN: number; readonly bufferedAmount: number; send: (data: string) => void }`
  - `createSendGate(socket: SendTarget): { send: (line: string) => void; finish: () => void }` — Task 2 adds `finish`'s behavior; Task 3 consumes both.

Why a fake socket rather than an integration test: `app.injectWS`'s duplex
pair drains synchronously, so `bufferedAmount` is always `0` under
`injectWS`. This code path is unreachable through the HTTP harness.

- [ ] **Step 1: Write the failing tests**

Create `server/test/logs-send-gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createSendGate } from "../src/routes/logs.js";

const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;

/**
 * The slice of a ws WebSocket the gate touches. `bufferedAmount` is
 * writable here so a test can simulate a client falling behind and
 * catching up; the real socket updates it as frames drain.
 */
function fakeSocket() {
  const sent: string[] = [];
  return {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    send: (data: string) => void sent.push(data),
    sent,
  };
}

describe("createSendGate", () => {
  it("forwards lines untouched while the queue is clear", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    gate.send("first");
    gate.send("second");

    expect(socket.sent).toEqual(["first", "second"]);
  });

  it("sends nothing when the socket is not OPEN", () => {
    const socket = fakeSocket();
    socket.readyState = 3; // CLOSED
    const gate = createSendGate(socket);

    gate.send("dropped on the floor");

    expect(socket.sent).toEqual([]);
  });

  it("suppresses and counts once the queue passes the high-water mark", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    socket.bufferedAmount = HIGH_WATER + 1;
    gate.send("one");
    gate.send("two");

    expect(socket.sent).toEqual([]);
  });

  it("stays suppressed while the queue sits between the marks", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    socket.bufferedAmount = HIGH_WATER + 1;
    gate.send("dropped");
    // Drained below high water but not below low water: still suppressed,
    // otherwise a client hovering here emits a notice on nearly every line.
    socket.bufferedAmount = LOW_WATER + 1;
    gate.send("also dropped");

    expect(socket.sent).toEqual([]);
  });

  it("emits one accurate notice before the resumed line, then resets", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    socket.bufferedAmount = HIGH_WATER + 1;
    gate.send("a");
    gate.send("b");
    gate.send("c");
    socket.bufferedAmount = 0;
    gate.send("resumed");
    gate.send("after");

    expect(socket.sent).toEqual([
      "⚠ 3 lines dropped (slow client)",
      "resumed",
      "after",
    ]);
  });

  it("emits no notice when nothing was dropped", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    socket.bufferedAmount = LOW_WATER + 1; // busy, but never suppressed
    gate.send("still fine");

    expect(socket.sent).toEqual(["still fine"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `server/`): `npx vitest run test/logs-send-gate.test.ts`

Expected: FAIL — `createSendGate` is not exported by `../src/routes/logs.js`
(TypeScript/Vitest reports it as an import or type error).

- [ ] **Step 3: Write the implementation**

In `server/src/routes/logs.ts`, add below `createLineForwarder` (after the
closing brace at ~line 66):

```ts
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
 * without limit. Above HIGH_WATER we stop sending and count the loss;
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
      // Task 2 fills this in.
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `server/`): `npx vitest run test/logs-send-gate.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/logs.ts server/test/logs-send-gate.test.ts
git commit -m "feat: drop log lines when the client send queue is deep"
```

---

## Task 2: Reporting a pending count at stream end

**Files:**
- Modify: `server/src/routes/logs.ts` (the `finish` stub from Task 1)
- Test: `server/test/logs-send-gate.test.ts` (append to the existing `describe`)

**Interfaces:**
- Consumes: `createSendGate` from Task 1 — same signature, `finish: () => void`.
- Produces: `finish()` behavior that Task 3's `end` handler relies on.

If the docker stream ends while the gate is suppressed, the pending count
would never be reported. `finish()` ignores the thresholds — nothing more
is coming, so there is no queue to protect — but still respects
`readyState`, to avoid inflating the sender's buffered-byte accounting
by writing to a socket that has already closed.

- [ ] **Step 1: Write the failing tests**

Append these three tests inside the `describe("createSendGate", ...)` block
in `server/test/logs-send-gate.test.ts`:

```ts
  it("finish() reports a pending count even with a deep queue", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    socket.bufferedAmount = HIGH_WATER + 1;
    gate.send("a");
    gate.send("b");
    gate.finish();

    expect(socket.sent).toEqual(["⚠ 2 lines dropped (slow client)"]);
  });

  it("finish() is a no-op when nothing was dropped", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    gate.send("all delivered");
    gate.finish();

    expect(socket.sent).toEqual(["all delivered"]);
  });

  it("finish() is silent when the socket is not OPEN", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    socket.bufferedAmount = HIGH_WATER + 1;
    gate.send("dropped");
    socket.readyState = 3; // CLOSED
    gate.finish();

    expect(socket.sent).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `server/`): `npx vitest run test/logs-send-gate.test.ts`

Expected: FAIL — the first new test gets `[]` instead of
`["⚠ 2 lines dropped (slow client)"]`, because `finish` is still a stub.
The other two pass already; that is fine.

- [ ] **Step 3: Write the implementation**

Replace the `finish` stub in `createSendGate` with:

```ts
    finish() {
      if (dropped === 0) return;
      if (socket.readyState !== socket.OPEN) return;
      socket.send(`⚠ ${dropped} lines dropped (slow client)`);
      dropped = 0;
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `server/`): `npx vitest run test/logs-send-gate.test.ts`

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/logs.ts server/test/logs-send-gate.test.ts
git commit -m "feat: report a pending drop count when the log stream ends"
```

---

## Task 3: Wire the gate into the route, document it, verify

**Files:**
- Modify: `server/src/routes/logs.ts:136-143` (the handler's forwarder setup
  and `end` handler)
- Modify: `README.md` (after the rate-limiting paragraph that ends
  "Reads are unlimited.", ~line 142)
- Test: `server/test/logs-routes.test.ts` — **read-only**, must pass unedited

**Interfaces:**
- Consumes: `createSendGate(socket)` returning `{ send, finish }` from Tasks 1–2.
- Produces: nothing further.

There is no new test in this task. The existing integration suite is the
wiring proof: every forwarding, flush, and close assertion in
`logs-routes.test.ts` now runs through the gate, with `bufferedAmount` at 0
throughout, so all of them must stay green **without edits**.

- [ ] **Step 1: Run the existing integration suite to confirm a green baseline**

Run (from `server/`): `npx vitest run test/logs-routes.test.ts`

Expected: PASS, 12 tests. Note the count — it must be identical after the
change.

- [ ] **Step 2: Wire the gate into the handler**

In `server/src/routes/logs.ts`, replace this block (currently at lines
136-143):

```ts
      const forwarder = createLineForwarder((line) => {
        if (socket.readyState === socket.OPEN) socket.send(line);
      });
      logs.stream.on("data", (chunk: Buffer) => forwarder.push(chunk));
      logs.stream.on("end", () => {
        forwarder.flush();
        socket.close(1000, "stream ended");
      });
```

with:

```ts
      const gate = createSendGate(socket);
      const forwarder = createLineForwarder((line) => gate.send(line));
      logs.stream.on("data", (chunk: Buffer) => forwarder.push(chunk));
      logs.stream.on("end", () => {
        forwarder.flush();
        gate.finish();
        socket.close(1000, "stream ended");
      });
```

The `readyState` check moves into the gate — do not leave a duplicate in
the callback. `gate.send` is wrapped in an arrow rather than passed by
reference so no lint rule can read it as an unbound method.

Leave the `error` handler and the `socket.on("close", ...)` teardown below
it exactly as they are.

- [ ] **Step 3: Run the full server suite**

Run (from `server/`): `npm test`

Expected: PASS, all files. `test/logs-routes.test.ts` still reports 12
tests and is unmodified — confirm with `git status` that it is not listed
as changed. `test/logs-send-gate.test.ts` reports 9.

- [ ] **Step 4: Typecheck and lint**

Run (from `server/`): `npm run typecheck && npm run lint`

Expected: both exit 0, no output. If lint flags the `SendTarget` interface
as unused, the gate was not wired up — recheck Step 2.

- [ ] **Step 5: Document the behavior in the README**

In `README.md`, immediately after the rate-limiting paragraph ending
"Reads are unlimited.", add a blank line and:

```markdown
Log streams are lossy under backpressure rather than unbounded: if a client
falls far enough behind that its send queue passes 1 MiB, the server drops
lines until the queue drains, then emits a single `⚠ N lines dropped (slow
client)` line in the stream. The panel keeps the last 2000 lines anyway.
```

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/logs.ts README.md
git commit -m "feat: apply the send gate to the log stream route"
```

---

## Definition of done

- `npm test`, `npm run typecheck`, `npm run lint` all pass in `server/`.
- `git status` is clean and `server/test/logs-routes.test.ts` was never
  modified.
- `git diff main --stat` touches exactly five files: `server/src/routes/logs.ts`,
  `server/test/logs-send-gate.test.ts`, `README.md`, and the two docs
  (this plan and the spec).
- No change to `server/package.json`, `package-lock.json`, or
  `server/src/types.ts`.
