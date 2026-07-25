# Concurrent Log-Stream Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap each user at 5 concurrently open log streams so aggregate
WebSocket memory is bounded, not just per-socket memory.

**Architecture:** A `createStreamRegistry()` factory in
`server/src/routes/logs.ts`, beside `createSendGate`, holding a
`Map<string, number>` of open streams per user. `logsRoutes()` creates one
registry per Fastify instance and the handler acquires a slot after the
origin check and before Docker is touched, releasing it on every teardown
path. Over the cap, the socket is closed with 1013 and the rejection is
audited fail-open.

**Tech Stack:** Node 22 + TypeScript (NodeNext), Fastify 5,
`@fastify/websocket`, Vitest. Server package only — no web changes.

**Spec:** `docs/superpowers/specs/2026-07-25-concurrent-stream-cap-design.md`

## Global Constraints

- Run every command **inside `server/`**. There are no npm workspaces; never run npm at the repo root.
- Relative imports in `server/` must end in `.js` (NodeNext), e.g. `from "../src/routes/logs.js"`, even though the sources are `.ts`.
- The cap value is exactly `5`, as `const MAX_STREAMS_PER_USER = 5;`.
- The close code is exactly `1013`; the close reason is exactly `` `Too many concurrent log streams (max ${MAX_STREAMS_PER_USER})` ``.
- The audit detail is exactly `` `concurrent log stream limit reached (${MAX_STREAMS_PER_USER})` ``.
- The stream key is exactly `user?.username ?? request.ip`, matching `rateLimitFor`'s `keyGenerator` in `server/src/ratelimit.ts:87`.
- The rejection audit is **fail-open** — use the existing `auditFailOpen` helper. Do not make this route fail closed.
- Registry state is created **inside `logsRoutes(app)`**, never at module scope. Module-level mutable state survives across Vitest files and would fail the next file's first open (the trap the rate-limit dedupe map hit).
- The existing tests in `server/test/logs-routes.test.ts` must stay green **without editing any existing test body or assertion**. Adding new helpers and new `describe` blocks is expected and fine, as is refactoring the *internals* of the existing `openSocket` helper — provided its signature and every existing call site are unchanged.
- No `server/src/types.ts` change, so `node scripts/sync-types.mjs` must not be needed and the CI `contract` job is unaffected. No dependency change, so no lockfile regeneration.
- Do not touch `server/src/docker.ts`, the `LogStream` interface, `createSendGate`, or anything in `web/`.

---

### Task 1: The stream registry

Pure unit, no socket and no Fastify. Establishes the interface Task 2 wires up.

**Files:**
- Modify: `server/src/routes/logs.ts` (add a constant and an exported factory after `createSendGate`, which ends at line 123)
- Create: `server/test/logs-stream-registry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MAX_STREAMS_PER_USER: number` — module-private constant, value `5`.
  - `export function createStreamRegistry(): { tryAcquire: (key: string) => (() => void) | null; readonly size: number }` — `tryAcquire` returns a release closure when a slot was taken, `null` when the key is at the cap. `size` is the number of keys with at least one open stream.

- [ ] **Step 1: Write the failing tests**

Create `server/test/logs-stream-registry.test.ts`. Note the local `CAP`
constant mirrors the module-private one, exactly as
`logs-send-gate.test.ts:4-5` mirrors `HIGH_WATER`/`LOW_WATER`.

```ts
import { describe, expect, it } from "vitest";
import { createStreamRegistry } from "../src/routes/logs.js";

/** Mirrors MAX_STREAMS_PER_USER, which logs.ts keeps private. */
const CAP = 5;

/** Fills a key to the cap and hands back the release closures, in order. */
function fill(
  registry: ReturnType<typeof createStreamRegistry>,
  key: string,
): (() => void)[] {
  const releases: (() => void)[] = [];
  for (let i = 0; i < CAP; i += 1) {
    const release = registry.tryAcquire(key);
    if (release === null) throw new Error(`refused slot ${i + 1} of ${CAP}`);
    releases.push(release);
  }
  return releases;
}

describe("createStreamRegistry", () => {
  it("allows acquisitions up to the cap", () => {
    const registry = createStreamRegistry();

    expect(fill(registry, "alice")).toHaveLength(CAP);
  });

  it("refuses the acquisition past the cap", () => {
    const registry = createStreamRegistry();
    fill(registry, "alice");

    expect(registry.tryAcquire("alice")).toBeNull();
  });

  it("frees exactly one slot on release", () => {
    const registry = createStreamRegistry();
    const releases = fill(registry, "alice");
    expect(registry.tryAcquire("alice")).toBeNull();

    releases[0]?.();

    expect(registry.tryAcquire("alice")).not.toBeNull();
    expect(registry.tryAcquire("alice")).toBeNull();
  });

  it("ignores a repeated release instead of freeing a second slot", () => {
    const registry = createStreamRegistry();
    const releases = fill(registry, "alice");

    releases[0]?.();
    releases[0]?.();

    expect(registry.tryAcquire("alice")).not.toBeNull();
    expect(registry.tryAcquire("alice")).toBeNull();
  });

  it("keeps a separate budget per key", () => {
    const registry = createStreamRegistry();
    fill(registry, "alice");
    expect(registry.tryAcquire("alice")).toBeNull();

    expect(registry.tryAcquire("bob")).not.toBeNull();
  });

  it("forgets a key once its last stream is released", () => {
    const registry = createStreamRegistry();
    const release = registry.tryAcquire("alice");
    expect(registry.size).toBe(1);

    release?.();

    expect(registry.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run test/logs-stream-registry.test.ts`
Expected: FAIL — the import cannot resolve `createStreamRegistry` (`"createStreamRegistry" is not exported by "src/routes/logs.ts"`).

- [ ] **Step 3: Write the implementation**

In `server/src/routes/logs.ts`, add this immediately after
`createSendGate` ends (line 123) and before the `logsRoutes` doc comment:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run test/logs-stream-registry.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `cd server && npm run typecheck && npm run lint`
Expected: both clean, no warnings.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/logs.ts server/test/logs-stream-registry.test.ts
git commit -m "feat: add a per-user log-stream registry"
```

---

### Task 2: Enforce the cap on the log route

Wires the registry into the handler, proves it end-to-end, and documents it.

**Files:**
- Modify: `server/src/routes/logs.ts` (`logsRoutes`, lines 131-210 before Task 1's insertion shifts them)
- Modify: `server/test/logs-routes.test.ts` (generalize the `openSocket` helper's internals, add helpers, add a new `describe`; do not edit existing test bodies)
- Modify: `README.md` (one paragraph after the backpressure paragraph at lines 144-147)

**Interfaces:**
- Consumes: `createStreamRegistry()` and `MAX_STREAMS_PER_USER` from Task 1.
- Produces: no new exports. Behavior contract — a sixth concurrent stream for one user closes with code `1013`, reason `Too many concurrent log streams (max 5)`, `streamContainerLogs` is never called for it, and one `container.logs` / `failure` audit row is written.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/logs-routes.test.ts`.

First, generalize the existing `openSocket` (line 43) to take a session,
by extracting its body into `openSocketAs` and having `openSocket`
delegate. **`openSocket`'s own signature and every existing call site stay
exactly as they are** — only its internals move. Move both of the existing
explanatory comments (the cookie-encoding one and the `socket:` one) into
`openSocketAs` verbatim; they explain the code that moved, not the
wrapper. Replace the whole existing `openSocket` function with:

```ts
/**
 * Opens a log stream as an arbitrary session. The cap is per user, so a
 * test that needs a second user calls this directly; openSocket wraps it
 * for the common case of the session beforeEach logged in.
 */
function openSocketAs(
  session: string,
  id: string,
  extraHeaders: Record<string, string> = {},
) {
  // cookies.session is the *decoded* value (set-cookie-parser undoes the
  // percent-encoding @fastify/cookie applies on the wire); injectWS's raw
  // headers option doesn't re-encode for us the way app.inject({ cookies })
  // does, so we must encode it ourselves to survive the Cookie header's
  // own ";"-separated parsing (secure-session's cipher;nonce value contains
  // a literal ";").
  return app.injectWS(`/api/logs/${id}`, {
    headers: {
      cookie: `session=${encodeURIComponent(session)}`,
      ...extraHeaders,
    },
    // A real upgrade gets req.socket for free from Node's HTTP server;
    // injectWS's fake request doesn't set one, and request.ip (used by the
    // audit call) reads raw.socket.remoteAddress under trustProxy — supply
    // it so the handler runs the same way it would in production.
    socket: { remoteAddress: "127.0.0.1" } as import("node:net").Socket,
  });
}

function openSocket(id = "abc123", extraHeaders: Record<string, string> = {}) {
  return openSocketAs(cookies.session, id, extraHeaders);
}
```

Then the remaining new helpers:

```ts
/**
 * A fresh PassThrough per call, unlike mockLogStream's single shared one:
 * these tests hold several streams open at once, and closing one socket
 * must not destroy another's source.
 */
function mockLogStreamPerCall(): PassThrough[] {
  const streams: PassThrough[] = [];
  mocked.streamContainerLogs.mockImplementation(() => {
    const stream = new PassThrough();
    streams.push(stream);
    return Promise.resolve({ stream, close: () => void stream.destroy() });
  });
  return streams;
}

/** Opens `count` streams for the logged-in user, ids c0…c(count-1). */
async function openMany(count: number) {
  const sockets: Awaited<ReturnType<typeof openSocket>>[] = [];
  for (let i = 0; i < count; i += 1) sockets.push(await openSocket(`c${i}`));
  return sockets;
}
```

Then the new describe block, at the end of the file:

```ts
describe("concurrent stream cap", () => {
  it("closes the sixth concurrent stream with 1013 without touching Docker", async () => {
    mockLogStreamPerCall();
    await openMany(5);
    expect(mocked.streamContainerLogs).toHaveBeenCalledTimes(5);

    const closed = await onClose(await openSocket("c5"));

    expect(closed).toEqual({
      code: 1013,
      reason: "Too many concurrent log streams (max 5)",
    });
    expect(mocked.streamContainerLogs).toHaveBeenCalledTimes(5);
  });

  it("audits the rejected stream as a failure", async () => {
    mockLogStreamPerCall();
    await openMany(5);

    await onClose(await openSocket("c5"));

    await vi.waitFor(() => expect(auditPage().total).toBe(6));
    const failures = auditPage().events.filter((e) => e.outcome === "failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      actor: "alice",
      action: "container.logs",
      outcome: "failure",
      target: "c5",
      detail: "concurrent log stream limit reached (5)",
    });
  });

  it("admits a new stream once an open one closes", async () => {
    const streams = mockLogStreamPerCall();
    const sockets = await openMany(5);

    sockets[0]?.close();
    // The route registers release() on the server socket's "close" before
    // the listener that calls logs.close(), so once the first source is
    // destroyed the slot is already free.
    await vi.waitFor(() => expect(streams[0]?.destroyed).toBe(true));

    await openSocket("c5");

    expect(mocked.streamContainerLogs).toHaveBeenCalledTimes(6);
  });

  it("caps each user separately", async () => {
    mockLogStreamPerCall();
    await openMany(5);
    expect((await onClose(await openSocket("c5"))).code).toBe(1013);

    const bob = await loginAs(app, "bob", "battery staple");
    await openSocketAs(bob.session, "c9");

    expect(mocked.streamContainerLogs).toHaveBeenCalledTimes(6);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run test/logs-routes.test.ts -t "concurrent stream cap"`
Expected: FAIL, 3 of the 4. No cap exists yet, so the sixth socket opens normally — the two 1013 assertions fail (the socket never closes, so `onClose` hangs until Vitest's timeout) and the audit test sees 6 successes and 0 failures. "admits a new stream once an open one closes" passes already; it is a regression guard for Task 2's release wiring, not a driver.

- [ ] **Step 3: Create the registry in `logsRoutes`**

In `server/src/routes/logs.ts`, change the opening of `logsRoutes` from:

```ts
export function logsRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>(
```

to:

```ts
export function logsRoutes(app: FastifyInstance): void {
  // Per Fastify instance, not module scope: tests build a fresh app per
  // case, and a module-level counter would survive across them.
  const streams = createStreamRegistry();

  app.get<{ Params: { id: string } }>(
```

- [ ] **Step 4: Acquire a slot after the origin check**

Still in `server/src/routes/logs.ts`, insert between the origin check's
closing `}` and the `let logs;` line:

```ts
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
```

- [ ] **Step 5: Release on the two early-return paths**

In the same handler, add `release();` as the first statement of the
`streamContainerLogs` catch block:

```ts
      } catch (err) {
        release();
        auditFailOpen(request, {
```

and as the first statement of the client-vanished branch:

```ts
      if (socket.readyState !== socket.OPEN) {
        // Client vanished while the stream was opening.
        release();
        logs.close();
        return;
      }
```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `cd server && npx vitest run test/logs-routes.test.ts -t "concurrent stream cap"`
Expected: PASS, 4 tests.

- [ ] **Step 7: Run the whole logs suite unmodified**

Run: `cd server && npx vitest run test/logs-routes.test.ts test/logs-send-gate.test.ts test/logs-stream-registry.test.ts`
Expected: PASS — 12 pre-existing route tests, 9 send-gate tests, 6 registry tests, 4 new cap tests. If a pre-existing route test needed editing to pass, stop: the cap changed normal-path behavior and the wiring is wrong.

- [ ] **Step 8: Run the full server suite, typecheck, and lint**

Run: `cd server && npm test && npm run typecheck && npm run lint`
Expected: all pass, no warnings. The pre-existing suite was 192 tests; expect 202.

- [ ] **Step 9: Document the cap in the README**

In `README.md`, add this paragraph immediately after the backpressure
paragraph that ends `The panel keeps the last 2000 lines anyway.` (line
147):

```markdown
One user may hold at most **5 log streams open at once**. A further open is
closed immediately with code `1013` and a reason naming the cap, and the
rejection is audited. Together with the per-stream 1 MiB ceiling above, that
bounds what one user's log streams can cost the server at 5 MiB.
```

- [ ] **Step 10: Commit**

```bash
git add server/src/routes/logs.ts server/test/logs-routes.test.ts README.md
git commit -m "feat: cap concurrent log streams per user"
```

---

## Verification

After both tasks, from the repo root:

```bash
cd server && npm test && npm run typecheck && npm run lint && npm run build
```

All four must pass before opening a PR. `web/` is untouched, so its suite
does not need to run locally — CI runs it regardless.
