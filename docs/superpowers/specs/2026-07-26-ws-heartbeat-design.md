# WebSocket Ping/Pong Heartbeat — Design

**Date:** 2026-07-26
**Status:** Approved
**Roadmap line:** "The heartbeat gap", shipped as documented-not-fixed with
the concurrent-stream cap (PR #11) and named there as the next logical
branch. See `2026-07-25-concurrent-stream-cap-design.md` § The heartbeat
gap.

## Problem

`GET /api/logs/:id` has no liveness check on its WebSocket. A peer that
disappears without a clean close — a slept laptop, a dropped Wi-Fi
network, a killed browser process — leaves the server holding an open
socket that nothing on the server ever notices.

That costs two things:

- **A stranded stream slot.** `createStreamRegistry` caps each user at 5
  concurrent streams and releases a slot on the socket's `close` event. A
  half-open socket never emits `close`, so the slot is held indefinitely.
  Five such events and the user cannot open a log panel at all, with no
  action they can take to recover it.
- **A stranded 1 MiB frame budget**, per `createSendGate`'s high-water
  mark, plus the dockerode stream behind it.

The server's only per-line signal that a peer is gone is a `send()` that
never drains, and `createSendGate` is built to *stop* sending in exactly
that state: once `bufferedAmount` passes `HIGH_WATER` it suppresses and
counts instead of writing. So the mechanism that would notice a dead peer
switches itself off precisely when the peer is dead. This is not a
regression in the gate — bounding a slow client's memory is its job — but
it does mean liveness cannot be inferred from the data path at all.

What bounds a stranded slot today is `proxy_read_timeout 1h` at
`web/nginx.conf:37`, which closes an idle upstream connection after an
hour. That is an hour late, and it exists only because of the bundled
nginx: a deployment that fronts the server with something else, or exposes
it directly, has no backstop and a stranded slot lives forever.

## Constraints

- **Browsers answer ping in the WebSocket stack, not in page JavaScript.**
  The browser WebSocket API exposes no ping/pong surface at all — a
  conforming client replies to a ping automatically and the page cannot
  see, delay, or suppress it. This is what makes a server-initiated
  heartbeat a **server-only change**: no `LogPanel` change, no
  `types.ts` change, no `contract` CI job involvement.
- **`ws`'s `ping()` is not safe to call blind.** Verified against
  `node_modules/ws/lib/websocket.js:367`: it *throws* synchronously when
  `readyState` is CONNECTING, and for CLOSING/CLOSED it silently no-ops
  via `sendAfterClose` (no error surfaces at all when no callback is
  passed — the failure is invisible). So a tick that skips the
  `readyState` check either throws or, worse, quietly does nothing while
  the interval keeps running against a socket that can never pong. Every
  tick checks `readyState` first.
- **A close handshake needs a live peer.** `close()` sends a close frame
  and waits for the peer's reply, parking the socket in CLOSING until
  `ws`'s own close timeout expires. A half-open peer by definition cannot
  reply, so `close()` is the wrong verb for the case being fixed.
- **An uncleared `setInterval` holds the Node event loop open**, which
  would hang `app.close()` and the Vitest process.
- **Module-scope mutable state leaks between tests** — the lesson from
  both `ratelimit.ts`'s dedupe map and `createStreamRegistry`. Heartbeat
  state is per socket, so this is satisfied structurally, but the timer
  must still be owned by the connection and not by the module.
- `@fastify/websocket` v11 passes the raw `ws` WebSocket as the handler's
  first argument, so `ping()`, `terminate()`, and the `"pong"` event are
  all directly available. No new dependency, so no lockfile regeneration.

## Design

A per-socket heartbeat, created where the send gate is created and torn
down by the socket's own `close` event.

```
… → tryAcquire → streamContainerLogs → audit → gate/forwarder wiring
    → createHeartbeat ──tick, no pong since last tick──→ terminate()
                                                       → "close" fires
                                                       → release() + logs.close()
```

### The unit

A fourth exported factory in `logs.ts`, beside `createSendGate`:

```ts
interface HeartbeatTarget {
  readonly readyState: number;
  readonly OPEN: number;
  ping: () => void;
  terminate: () => void;
}

export function createHeartbeat(
  socket: HeartbeatTarget,
  options?: { intervalMs?: number; onTimeout?: () => void },
): { pong: () => void; stop: () => void };
```

Same shape as its neighbours: a factory over a narrow interface — the
slice of a `ws` socket it actually touches — unit-testable with a plain
object, no Fastify and no real WebSocket.

The route wires the `"pong"` event rather than the heartbeat subscribing
itself. This keeps `HeartbeatTarget` to the two methods the unit *calls*,
matching how `SendTarget` describes only `send`, and keeps every socket
listener in the route where the teardown wiring already lives.

### One timer, not two

A single `setInterval(intervalMs)` and one `awaitingPong` flag. Each tick:

1. `readyState !== OPEN` → `stop()` and return. Nothing to ping, and the
   `close` event owns the slot release.
2. `awaitingPong` still true — no pong arrived since the previous tick →
   the peer is dead: `stop()`, `onTimeout?.()`, `socket.terminate()`.
3. Otherwise → `awaitingPong = true`, `socket.ping()`.

`pong()` clears `awaitingPong`. `stop()` clears the interval and is
idempotent.

This is the standard `ws` `isAlive` pattern, and its timing property is
worth stating precisely because it is easy to misdescribe: a peer that
goes silent is detected on the **second** tick after its last pong, so
between one and two intervals — **30 to 60 seconds**, worst case 60. Not a
flat 60. The code comment says 30–60s.

The alternative — a second `setTimeout` armed per ping for an exact
deadline — buys a tighter bound at the cost of a second timer per socket
to create, clear, and reason about on every teardown path. Not worth it
for a bound whose only requirement is "minutes, not hours".

### Constants

```ts
const PING_INTERVAL_MS = 30_000;
```

A module constant alongside `HIGH_WATER`, `LOW_WATER`, and
`MAX_STREAMS_PER_USER` — the established way every limit in this file is
expressed. Deliberately **not** an env var: that would add two entries to
the env surface, plus CLAUDE.md and README lines, for a knob nobody has
asked to turn. `intervalMs` is an optional argument only so unit tests
need not wait half a minute.

30s is comfortably inside common intermediary idle timeouts (nginx's
`proxy_read_timeout` here is 1h, but 60s is a widespread default
elsewhere), and gives 30–60s slot reclamation against today's 1h-or-never.

### `terminate()`, not `close()`

`terminate()` destroys the socket immediately and emits `close` with
1006. That matters twice over: it is the only verb that works on a peer
that cannot complete a handshake (see Constraints), and the `close` event
it emits runs the route's **existing** listeners —
`socket.on("close", release)` and `socket.on("close", () => logs.close())`.

So the slot and the dockerode stream are freed through the paths already
in place and already tested. The heartbeat adds no teardown path of its
own, and there is no second copy of the release logic to keep in sync.

### Route wiring

Immediately after the gate and forwarder are wired, so a heartbeat exists
only once the stream is genuinely live — after the origin check, the cap
check, the Docker call, and the `readyState !== OPEN` early return:

```ts
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

### Interaction with the send gate

The heartbeat calls `socket.ping()` directly, bypassing `createSendGate`.
This is deliberate and is the crux of the fix: gate suppression is exactly
the state in which nothing else touches the socket, so liveness has to
route around it.

An empty ping is a 2-byte frame. It cannot perturb the gate's hysteresis,
whose marks are 256 KiB and 1 MiB.

A slow-but-alive client is not at risk: once its queue drains, its pongs
arrive and the heartbeat resets. Only a client whose socket never drains
for a full interval is terminated — which is the definition of a dead
peer, not a slow one.

### Logging, not auditing

A missed pong writes one `request.log.info` line and no audit row.

The three failures this handler audits — invalid origin, cap reached,
Docker error — are policy decisions or server faults. A missed pong is a
network fact: a closed laptop lid, a train tunnel. Auditing it would put a
row on the audit page every time someone shuts a laptop, diluting the
record of authorization decisions that the page exists to show. The
stream's *open* is already audited, so the event is not invisible.

The log line carries `target` and `actor` so a stranded-slot complaint
can still be traced.

### No `unref()`

`setInterval(...).unref()` would stop a leaked timer from holding the
process open. Rejected: that converts a leak from a loud hang into a
silent one. The timer's lifetime is owned by `stop()` and the `close`
listener, and the test suite's own exit is the check on that.

## Alternatives rejected

- **One server-wide interval over `app.websocketServer.clients`** (the
  pattern in `ws`'s own docs). One timer total instead of one per stream,
  but it reaches past the route into the raw `wss`, silently applies to
  every WS route added later, needs a `WeakMap` or property-stamping for
  per-socket `isAlive`, and must be torn down in `app.ts`'s lifecycle.
  At roster × 5 sockets the timer saving is meaningless, and per-socket
  scope keeps the heartbeat's lifetime identical to the slot it protects.
- **Application-level ping as a text frame**, answered by `LogPanel`.
  Works, but invents a protocol on a stream whose frames are currently
  *all* log lines, requires the client to distinguish control text from
  log text (a log line reading `"ping"` is a real possibility), and needs
  web changes and web tests to do what the WebSocket protocol already
  does for free.
- **Lower the nginx `proxy_read_timeout`.** Tightens the existing bound
  but reclaims nothing off-proxy, and leaves the direct-exposure case
  unbounded. Not a fix.
- **Evict on `bufferedAmount` staying pinned at `HIGH_WATER`.** Reuses
  state the gate already tracks, but conflates "slow" with "dead" — a
  genuinely slow client on a bad connection gets killed — and misses a
  dead peer that went silent with an empty queue, which is the common
  case.
- **Client-side auto-reconnect in `LogPanel`.** A UX feature, not this
  defect: it does not reclaim the server-side slot, which is the actual
  bug. Needs backoff policy, reconnect state, and duplicate-line handling
  on re-tail. Out of scope.

## Testing

Vitest, `server/test/`.

**New unit tests** — `server/test/logs-heartbeat.test.ts`, fake socket in
the style of `logs-send-gate.test.ts`, plus `vi.useFakeTimers()`:

- pings once per interval while pongs keep arriving
- survives several cycles with a pong each cycle: `terminate` never called
- no pong → `terminate` called exactly once, on the second tick, not the
  first
- after a timeout the interval is stopped: no further pings, no second
  `terminate`
- `onTimeout` fires on the timeout path and never on the healthy path
- `stop()` silences it, and is idempotent
- a socket whose `readyState` is not OPEN is never pinged, and the timer
  stops

**New integration test** in `logs-routes.test.ts` — the part unit tests
cannot reach, and the one that actually proves the bug is fixed.
`injectWS` builds a real `ws` client over a duplex stream pair, so real
control frames flow. Pausing the client's underlying stream produces a
genuine half-open peer: the ping is never processed, so no pong is ever
sent.

- **Slot reclamation, proven through the real registry.** Open 5 streams
  as one user (the cap), strand one by pausing its client stream, advance
  timers past two intervals, then assert a 6th open **succeeds**. This
  proves the released slot through observable route behavior rather than
  by inspecting internals — and it is the exact scenario in the Problem
  section.
- **A healthy client is not killed.** A normal `injectWS` client (which
  pongs automatically) stays open across several intervals.

Both need `streamContainerLogs` mocked with `mockImplementation` returning
a **fresh** `PassThrough` per call, as the existing cap tests do — the
shared-stream `mockLogStream()` helper would let one socket's teardown
destroy another's source.

**Known risk, with a stated fallback.** These two tests drive fake timers
against real streams. `vi.advanceTimersByTimeAsync` flushes microtasks
between timer callbacks and `ws`'s data path is `nextTick`-driven, so this
is expected to work. If it proves flaky, the fallback is to thread an
internal `{ pingIntervalMs }` option through `logsRoutes(app, options)`
so the test can build an app with a 20 ms interval and use real timers;
`buildApp` passes nothing and the shipped default is unchanged. Recording
the fallback here so the choice is a decision rather than a mid-
implementation scramble.

**Existing `logs-routes.test.ts` tests must stay green unmodified.** They
run well inside one interval, so any forced change there means the
heartbeat altered normal-path behavior.

## Docs

One line in CLAUDE.md's Gotchas, replacing the currently load-bearing but
about-to-be-false claim that `proxy_read_timeout 1h` is the only bound on
a stranded stream slot.

No README change — it documents neither the stream cap nor the timeouts.
No `types.ts` change, so `scripts/sync-types.mjs` does not run and the
`contract` job is unaffected. No dependency change, so no lockfile
regeneration.

## Out of scope

- `web/` entirely: no `LogPanel` change, no reconnect, no staleness
  indicator. Browsers pong without page involvement.
- Heartbeats on any other route (there is only one WS route today).
- Env-configurable timings.
- Changing `proxy_read_timeout`, `createSendGate`, `createStreamRegistry`,
  `docker.ts`, or the `LogStream` interface.
- `scripts/smoke.mjs`: a 30s heartbeat cannot be asserted in a smoke run
  without adding 60s of sleep to every CI PR. The compose path stays
  covered by the existing four checks.
