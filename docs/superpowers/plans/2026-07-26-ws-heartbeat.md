# WebSocket Ping/Pong Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect a half-open WebSocket peer on `GET /api/logs/:id` within 30–60 seconds and terminate it, so its concurrent-stream slot and 1 MiB frame budget are reclaimed instead of stranded until nginx's 1h idle timeout (or forever, off-proxy).

**Architecture:** A per-socket `createHeartbeat()` factory in `server/src/routes/logs.ts` — the fourth in that file, alongside `createLineForwarder`, `createSendGate`, and `createStreamRegistry`. One `setInterval` and one `awaitingPong` flag: each tick either pings or, if the previous tick's ping went unanswered, calls `socket.terminate()`. Terminating fires the socket's `close` event, which runs the route's **existing** `release` and `logs.close()` listeners — so no new teardown path is introduced. Browsers answer ping inside the WebSocket stack, with no page involvement, so this is a server-only change.

**Tech Stack:** Node 22 ESM, TypeScript (NodeNext — relative imports end in `.js`), Fastify 5, `@fastify/websocket` v11 (hands the raw `ws` WebSocket to the handler), Vitest 4 with `vi.useFakeTimers()`.

**Spec:** `docs/superpowers/specs/2026-07-26-ws-heartbeat-design.md`

**Branch:** `ws-heartbeat` (already created, spec committed as `5f14771`).

## Global Constraints

- All work happens in `server/`. Run every npm command from `C:\Users\Owner\Repos\fleet-console\server` — there are no workspaces, and the repo root has no package.json.
- **No `web/` change and no `server/src/types.ts` change.** Browsers pong automatically; there is no new API contract. `scripts/sync-types.mjs` must not run, and the `contract` CI job must be unaffected.
- **No new dependency.** `ping()`, `terminate()`, and the `"pong"` event all come from `ws`, already present via `@fastify/websocket`. No lockfile regeneration (which would otherwise require npm 10, not the local npm 11).
- Relative imports in `server/` must end in `.js` even though sources are `.ts` (NodeNext).
- `PING_INTERVAL_MS = 30_000` is a module constant, **not** an env var.
- Detection latency is **30–60 seconds** (one to two intervals), worst case 60. Do not describe it as a flat 60s in code comments or commit messages.
- A missed pong writes **one `request.log.info` line and no audit row**.
- Do not add `.unref()` to the interval.
- Existing tests in `server/test/logs-routes.test.ts` must stay green **unmodified**. If one needs changing, the heartbeat altered normal-path behavior — stop and report rather than editing the test.
- Commit messages: no `Co-Authored-By` trailer in this project.

---

### Task 1: `createHeartbeat()` unit

**Files:**
- Create: `server/test/logs-heartbeat.test.ts`
- Modify: `server/src/routes/logs.ts` (add `HeartbeatTarget`, `PING_INTERVAL_MS`, `createHeartbeat` after `createStreamRegistry`, which ends at line 171)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, for Task 2:
  ```ts
  export function createHeartbeat(
    socket: HeartbeatTarget,
    options?: { intervalMs?: number; onTimeout?: () => void },
  ): { pong: () => void; stop: () => void };
  ```
  where `HeartbeatTarget` is `{ readonly readyState: number; readonly OPEN: number; ping: () => void; terminate: () => void }`. `HeartbeatTarget` stays **unexported** (`SendTarget` is unexported too; the tests pass a structurally compatible object literal).

- [ ] **Step 1: Write the failing test file**

Create `server/test/logs-heartbeat.test.ts`. The fake socket mirrors `logs-send-gate.test.ts`'s idiom — closure-held counters rather than `this`, and a mutable `readyState` so a test can close the socket mid-flight.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeat } from "../src/routes/logs.js";

/** The shipped interval. Tests advance fake timers by this, so they also
 *  pin the default rather than only testing an injected override. */
const INTERVAL = 30_000;

/**
 * The slice of a ws WebSocket the heartbeat touches. `readyState` is
 * writable here so a test can simulate the socket closing between ticks;
 * the real socket updates it itself.
 */
function fakeSocket() {
  const calls = { pings: 0, terminates: 0 };
  return {
    readyState: 1,
    OPEN: 1,
    ping: () => void (calls.pings += 1),
    terminate: () => void (calls.terminates += 1),
    calls,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createHeartbeat", () => {
  it("pings once per interval while pongs keep arriving", () => {
    const socket = fakeSocket();
    const heartbeat = createHeartbeat(socket);

    vi.advanceTimersByTime(INTERVAL);
    expect(socket.calls.pings).toBe(1);

    heartbeat.pong();
    vi.advanceTimersByTime(INTERVAL);
    expect(socket.calls.pings).toBe(2);

    heartbeat.stop();
  });

  it("never terminates a peer that answers every ping", () => {
    const socket = fakeSocket();
    const heartbeat = createHeartbeat(socket);

    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(INTERVAL);
      heartbeat.pong();
    }

    expect(socket.calls.pings).toBe(5);
    expect(socket.calls.terminates).toBe(0);

    heartbeat.stop();
  });

  it("terminates on the second tick, not the first", () => {
    const socket = fakeSocket();
    createHeartbeat(socket);

    vi.advanceTimersByTime(INTERVAL);
    expect(socket.calls).toEqual({ pings: 1, terminates: 0 });

    vi.advanceTimersByTime(INTERVAL);
    expect(socket.calls).toEqual({ pings: 1, terminates: 1 });
  });

  it("stops the interval once it has terminated a dead peer", () => {
    const socket = fakeSocket();
    createHeartbeat(socket);

    vi.advanceTimersByTime(INTERVAL * 5);

    expect(socket.calls).toEqual({ pings: 1, terminates: 1 });
  });

  it("reports the timeout through onTimeout, before terminating", () => {
    const socket = fakeSocket();
    const order: string[] = [];
    createHeartbeat(
      { ...socket, terminate: () => void order.push("terminate") },
      { onTimeout: () => void order.push("onTimeout") },
    );

    vi.advanceTimersByTime(INTERVAL * 2);

    expect(order).toEqual(["onTimeout", "terminate"]);
  });

  it("does not call onTimeout on the healthy path", () => {
    const socket = fakeSocket();
    const onTimeout = vi.fn();
    const heartbeat = createHeartbeat(socket, { onTimeout });

    vi.advanceTimersByTime(INTERVAL);
    heartbeat.pong();
    vi.advanceTimersByTime(INTERVAL);

    expect(onTimeout).not.toHaveBeenCalled();

    heartbeat.stop();
  });

  it("goes silent after stop(), which is idempotent", () => {
    const socket = fakeSocket();
    const heartbeat = createHeartbeat(socket);

    heartbeat.stop();
    heartbeat.stop();
    vi.advanceTimersByTime(INTERVAL * 5);

    expect(socket.calls).toEqual({ pings: 0, terminates: 0 });
  });

  it("never pings a socket that is not OPEN", () => {
    const socket = fakeSocket();
    socket.readyState = 3; // CLOSED
    createHeartbeat(socket);

    vi.advanceTimersByTime(INTERVAL * 5);

    expect(socket.calls).toEqual({ pings: 0, terminates: 0 });
  });

  it("stops rather than terminating a socket that closed while awaiting a pong", () => {
    const socket = fakeSocket();
    createHeartbeat(socket);

    vi.advanceTimersByTime(INTERVAL);
    expect(socket.calls.pings).toBe(1);

    // The peer went away cleanly before answering. The readyState guard runs
    // before the awaitingPong check, so there is nothing left to terminate —
    // the socket's own "close" event owns the teardown.
    socket.readyState = 3;
    vi.advanceTimersByTime(INTERVAL * 5);

    expect(socket.calls.terminates).toBe(0);
  });

  it("honors a custom intervalMs", () => {
    const socket = fakeSocket();
    const heartbeat = createHeartbeat(socket, { intervalMs: 1_000 });

    vi.advanceTimersByTime(1_000);

    expect(socket.calls.pings).toBe(1);

    heartbeat.stop();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- logs-heartbeat`
Expected: the file fails to collect — `createHeartbeat` is not exported from `../src/routes/logs.js`. (A TypeScript/import error here is the expected failure, not a problem to work around.)

- [ ] **Step 3: Implement `createHeartbeat`**

In `server/src/routes/logs.ts`, insert after `createStreamRegistry` ends (line 171) and before the `logsRoutes` JSDoc block. Keep the comment density of the surrounding factories — this file explains *why* at every non-obvious decision.

```ts
/** How often an open log-stream socket is pinged. */
const PING_INTERVAL_MS = 30_000;

/** The slice of a ws WebSocket the heartbeat needs. */
interface HeartbeatTarget {
  readonly readyState: number;
  readonly OPEN: number;
  ping: () => void;
  terminate: () => void;
}

/**
 * Liveness for one log stream. A peer that vanishes without a close frame
 * (slept laptop, dropped Wi-Fi, killed browser) otherwise holds its stream
 * slot and its 1 MiB frame budget indefinitely: the socket never emits
 * "close", so `release` never runs. The data path cannot detect it either —
 * createSendGate stops sending once bufferedAmount passes HIGH_WATER, which
 * is exactly the state a dead peer produces, so the only per-line dead-peer
 * signal switches itself off precisely when it would fire. Before this, the
 * sole bound was nginx's `proxy_read_timeout 1h`, which does not exist
 * outside the bundled proxy.
 *
 * One interval and one flag, the standard ws `isAlive` pattern: a tick with
 * last tick's ping still unanswered means the peer is gone. Detection
 * therefore lands between one and two intervals after the peer goes silent
 * — 30 to 60 seconds, not a flat 60. An exact deadline would need a second
 * timer per socket to arm and clear on every teardown path, which is not
 * worth it for a bound whose only requirement is minutes rather than hours.
 *
 * `terminate()` rather than `close()`: a close handshake needs a peer that
 * can answer, and this peer by definition cannot — `close()` would park the
 * socket in CLOSING until ws's own close timeout. terminate() destroys it
 * now and emits "close" (1006), which runs the route's existing release and
 * logs.close() listeners, so the heartbeat adds no teardown path of its own.
 *
 * Pings bypass createSendGate deliberately: gate suppression is the very
 * state in which nothing else touches the socket. An empty ping is a 2-byte
 * frame and cannot perturb the gate's 256 KiB / 1 MiB hysteresis.
 *
 * The interval is not unref()'d — a leaked timer should hang loudly rather
 * than be masked. Its lifetime is owned by stop() and the route's "close"
 * listener.
 */
export function createHeartbeat(
  socket: HeartbeatTarget,
  {
    intervalMs = PING_INTERVAL_MS,
    onTimeout,
  }: { intervalMs?: number; onTimeout?: () => void } = {},
): { pong: () => void; stop: () => void } {
  let awaitingPong = false;
  let timer: NodeJS.Timeout | null = null;

  const stop = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  timer = setInterval(() => {
    // ws's ping() throws on a CONNECTING socket and silently no-ops on a
    // CLOSING/CLOSED one, so this guard comes first. It also means a socket
    // that closed while awaiting a pong is simply dropped, not terminated:
    // its own "close" event already owns the teardown.
    if (socket.readyState !== socket.OPEN) {
      stop();
      return;
    }
    if (awaitingPong) {
      stop();
      onTimeout?.();
      socket.terminate();
      return;
    }
    awaitingPong = true;
    socket.ping();
  }, intervalMs);

  return {
    pong: () => {
      awaitingPong = false;
    },
    stop,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- logs-heartbeat`
Expected: 10 passed. If the run does not exit, an interval is outliving a test — check that every test either calls `heartbeat.stop()` or lets the timeout path stop it.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean. `onTimeout?.()` on an optional callback and the `NodeJS.Timeout | null` timer both satisfy the type-checked ESLint rules; if `@typescript-eslint/no-unnecessary-condition` flags the `timer === null` check, keep the check and report it rather than deleting the idempotency guard.

- [ ] **Step 6: Run the whole server suite**

Run: `npm test`
Expected: every existing test still passes. `createHeartbeat` is not wired into the route yet, so nothing else should move.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/logs.ts server/test/logs-heartbeat.test.ts
git commit -m "feat: add createHeartbeat for WS log-stream liveness"
```

---

### Task 2: Wire the heartbeat into the log route

**Files:**
- Modify: `server/src/routes/logs.ts` (the `logsRoutes` handler, after the stream wiring that currently ends at line 292 with `socket.on("close", () => logs.close());`)
- Test: `server/test/logs-routes.test.ts` (append a new `describe` block after the `concurrent stream cap` block, which ends at line 397)

**Interfaces:**
- Consumes: `createHeartbeat(socket, { intervalMs?, onTimeout? })` from Task 1, returning `{ pong, stop }`.
- Produces: no new exports. Observable behavior only — a silent peer's socket is terminated and its stream slot is reclaimed.

- [ ] **Step 1: Write the failing integration tests**

Append to `server/test/logs-routes.test.ts`. These reuse the helpers already in that file — `mockLogStreamPerCall()` (fresh `PassThrough` per call, so one socket's teardown cannot destroy another's source), `openMany()`, and `openSocket()`.

`sockets[0].pause()` is what makes this a *real* half-open peer rather than a mocked one: `ws`'s `pause()` pauses the underlying stream, so the client never reads the ping frame and therefore never sends the automatic pong.

Fake timers must be installed **before** the sockets are opened — an interval created by the real `setInterval` is not controlled by fake timers installed afterwards.

```ts
describe("heartbeat", () => {
  const INTERVAL = 30_000;

  afterEach(() => {
    // Restore before the outer afterEach calls app.close(), which should
    // never run under fake timers.
    vi.useRealTimers();
  });

  it("terminates a peer that stops answering pings and frees its slot", async () => {
    // Installed before the sockets exist: the heartbeat's interval is
    // created at open, and a real interval ignores fake timers installed
    // after the fact.
    vi.useFakeTimers();
    const streams = mockLogStreamPerCall();
    const sockets = await openMany(5);

    // A genuine half-open peer: pausing the client's socket stops it
    // reading the ping, so ws never sends the automatic pong.
    sockets[0]?.pause();

    await vi.advanceTimersByTimeAsync(INTERVAL); // ping goes out
    await vi.advanceTimersByTimeAsync(INTERVAL); // no pong -> terminate
    vi.useRealTimers();

    // terminate() emits "close", which runs the route's existing release
    // and logs.close() listeners — the destroyed source proves both ran.
    await vi.waitFor(() => expect(streams[0]?.destroyed).toBe(true));

    // The real proof: the user was at the cap of 5, so a sixth open can
    // only reach Docker if the stranded slot came back.
    await openSocket("c5");
    expect(mocked.streamContainerLogs).toHaveBeenCalledTimes(6);
  });

  it("leaves a client that answers pings alone", async () => {
    vi.useFakeTimers();
    const streams = mockLogStreamPerCall();
    await openSocket("c0");

    // injectWS's client is a real ws instance, so it pongs on its own.
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(INTERVAL);
    }
    vi.useRealTimers();

    expect(streams[0]?.destroyed).toBe(false);
  });

  it("does not audit a heartbeat timeout", async () => {
    vi.useFakeTimers();
    const streams = mockLogStreamPerCall();
    const sockets = await openMany(1);
    sockets[0]?.pause();

    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    vi.useRealTimers();

    await vi.waitFor(() => expect(streams[0]?.destroyed).toBe(true));

    // Exactly the one success row for the open. A dropped network is a
    // network fact, not an authorization decision.
    const page = auditPage();
    expect(page.total).toBe(1);
    expect(page.events[0]).toMatchObject({
      action: "container.logs",
      outcome: "success",
      target: "c0",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- logs-routes`
Expected: the first test fails (`streams[0].destroyed` stays `false`, or the sixth open is rejected at the cap so `streamContainerLogs` was called 5 times) and the third fails on the same timeout. The second ("leaves a client that answers pings alone") **passes already** — nothing terminates anything yet. That is expected: it is the regression guard, not the driver.

**If instead the run hangs or the sockets never open**, the fake-timers-over-real-streams risk in the spec has materialized. Apply this documented fallback rather than improvising:

1. `server/src/routes/logs.ts` — accept the interval as a plugin option:
   ```ts
   export function logsRoutes(
     app: FastifyInstance,
     options: { pingIntervalMs?: number } = {},
   ): void {
   ```
   and pass it through: `createHeartbeat(socket, { intervalMs: options.pingIntervalMs, onTimeout: … })` — `undefined` falls back to `PING_INTERVAL_MS` via the default parameter, so production is unchanged.
2. `server/src/app.ts` — add `pingIntervalMs?: number` to the existing `BuildAppOptions` interface and register with it: `await app.register(logsRoutes, { pingIntervalMs: opts.pingIntervalMs });`
3. In the tests, drop the fake timers: build a second app with `await buildApp({ pingIntervalMs: 20 })`, log in against it, and `await vi.waitFor(...)` on real timers.

Report which route you took in the task completion notes either way.

- [ ] **Step 3: Wire the heartbeat into the handler**

In `logsRoutes`, immediately after the existing `socket.on("close", () => logs.close());` at the end of the handler:

```ts
      // Created only once the stream is genuinely live — after the origin
      // check, the cap check, the Docker call, and the vanished-client early
      // return. Logged, not audited: a missed pong is a network fact (a shut
      // laptop, a train tunnel), not an authorization decision, and a row per
      // closed lid would dilute the audit page. The open above is audited, so
      // the stream is still traceable.
      const heartbeat = createHeartbeat(socket, {
        onTimeout: () =>
          request.log.info(
            { target: id, actor: user?.username ?? "unknown" },
            "log stream heartbeat timeout",
          ),
      });
      socket.on("pong", () => heartbeat.pong());
      socket.on("close", () => heartbeat.stop());
```

- [ ] **Step 4: Run the log-route tests to verify they pass**

Run: `npm test -- logs-routes`
Expected: all three new tests pass, and **all pre-existing tests in the file pass unmodified**. If an existing test now fails, the heartbeat changed normal-path behavior — stop and report; do not edit the test to suit.

- [ ] **Step 5: Run both new files together**

Run: `npm test -- logs`
Expected: `logs-heartbeat`, `logs-routes`, `logs-send-gate`, and `logs-stream-registry` all green. This catches a timer leaking across files.

- [ ] **Step 6: Run the whole server suite, then typecheck and lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green, and the test process exits on its own. A hang here means an interval outlived its socket — check the `close` listener wiring, not the test.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/logs.ts server/test/logs-routes.test.ts
git commit -m "feat: terminate half-open log-stream peers via WS heartbeat"
```

---

### Task 3: Document the liveness guarantee and verify the branch

**Files:**
- Modify: `CLAUDE.md` (the WebSocket-route gotcha bullet, line 32)

**Interfaces:**
- Consumes: the shipped behavior from Task 2.
- Produces: nothing consumed by later tasks.

**Correction to the spec, carried out here:** the spec's Docs section says this replaces a load-bearing claim in CLAUDE.md that `proxy_read_timeout 1h` is the only bound. Verified: **that claim is not in CLAUDE.md** — it lives in `2026-07-25-concurrent-stream-cap-design.md` § The heartbeat gap and in project memory. So this task *adds* a sentence about liveness to the existing WS bullet instead of replacing anything. Leave the older spec alone: it is a dated design record, and rewriting shipped history to look prescient is worse than a stale follow-up note.

- [ ] **Step 1: Extend the WebSocket gotcha bullet**

In `CLAUDE.md`, append to the bullet that begins ``- `GET /api/logs/:id` is a WebSocket route``, after the sentence ending "…before assuming the proxy layer is a solved problem.":

```markdown
 A 30s `createHeartbeat` ping guards liveness: two ticks without a pong (so 30–60s after a peer goes silent) and the socket is `terminate()`d, which fires the `close` listeners that free the per-user stream slot — so don't add a competing teardown path, and don't reach for `close()` here (a half-open peer can't finish a handshake). Tests drive it by installing `vi.useFakeTimers()` **before** opening the socket (an interval created by the real timer ignores fake timers installed later) and `sockets[n].pause()` to make a client stop answering.
```

- [ ] **Step 2: Verify the doc claims against the code**

Run: `npm run typecheck` from `server/`, and re-read the modified bullet against `server/src/routes/logs.ts`.
Expected: every number and identifier in the new sentence matches the code — `30s`, `30–60s`, `createHeartbeat`, `terminate()`, `pause()`. A gotcha that misstates the code is worse than no gotcha.

- [ ] **Step 3: Full verification of both packages**

Run from `server/`: `npm test && npm run typecheck && npm run lint && npm run build`
Then from `web/`: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all green. `web/` must be untouched — it is verified here only to prove that.

- [ ] **Step 4: Confirm the diff's blast radius**

Run: `git diff main --stat`
Expected exactly five files: the spec and plan docs, `CLAUDE.md`, `server/src/routes/logs.ts`, `server/test/logs-heartbeat.test.ts`, `server/test/logs-routes.test.ts`. **No `web/` file, no `server/src/types.ts`, no lockfile.** Anything else is out of scope and must be reported.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record the log-stream heartbeat and its test idiom"
```

(The spec and plan documents are already committed on this branch — Task 3
Step 4's five-file expectation counts them.)

---

## Self-Review

**Spec coverage.** Problem → Task 2's reclamation test. Constraints: browser-pongs/server-only → Global Constraints + Task 3 Step 4; `ping()` unsafe blind → Task 1 Step 3 guard + the "not OPEN" and "closed while awaiting" tests; close-handshake → `terminate()` in Task 1, restated in Task 3's doc line; uncleared interval → Task 1 Step 4 and Task 2 Step 6 hang checks; no new dependency → Global Constraints. Design: the unit → Task 1; one timer/one flag and the 30–60s bound → Task 1 Steps 1 and 3; constants not env → Global Constraints; `terminate()` → Task 1; route wiring → Task 2 Step 3; gate interaction → Task 1's comment; logging not auditing → Task 2's third test; no `unref()` → Global Constraints. Testing: all nine spec-listed unit cases are present (split into 10 `it`s — `onTimeout` fires and does-not-fire are separate tests), both integration cases present, plus the audit-silence test the spec implied but did not list. Fallback → Task 2 Step 2. Docs → Task 3, with the spec's inaccuracy corrected in place rather than propagated. Alternatives-rejected sections need no tasks.

**Placeholders.** None: every code step carries the real code, every run step names the exact command and expected result.

**Type consistency.** `createHeartbeat(socket, { intervalMs?, onTimeout? }) → { pong, stop }` is identical in Task 1's Interfaces block, Task 1's implementation, Task 2's Interfaces block, and Task 2's wiring. `HeartbeatTarget` is unexported in all three mentions. `PING_INTERVAL_MS` is the only constant name used. The fallback's `pingIntervalMs` option name is distinct from the unit's `intervalMs` on purpose — one is a plugin option, the other a factory argument — and both appear with their exact spelling at every use.
