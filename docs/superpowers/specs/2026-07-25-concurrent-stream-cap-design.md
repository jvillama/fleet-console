# Concurrent Log-Stream Cap — Design

**Date:** 2026-07-25
**Status:** Approved
**Roadmap line:** The remaining half of the Phase-2 review note "send
backpressure via `bufferedAmount` pause/resume + concurrent-stream cap".
Backpressure shipped as PR #10; this closes the pair.

## Problem

`createSendGate` (PR #10) bounds what *one* log stream can cost the server
at 1 MiB of queued frames. Nothing bounds how many streams one user can
hold open at once. Aggregate exposure is therefore 1 MiB × open streams,
and open streams are limited only by the file-descriptor ceiling — the
backpressure work converted an unbounded-per-socket problem into an
unbounded-number-of-sockets problem.

Two ways this bites, neither requiring malice:

- A scripted or buggy client that opens a stream per container across a
  large fleet, or reconnects in a loop without closing.
- Zombie sockets: a laptop that sleeps or a network that drops leaves the
  server holding a socket, and its 1 MiB budget, until TCP notices.

The route also has no rate limit (`rateLimitFor` is applied only to the
five mutating routes), so nothing throttles the open rate either. A cap on
concurrency is the more direct control: it bounds the resource rather than
the request rate.

## Constraints

- **The user roster is fixed configuration.** `FLEET_USERS` /
  `FLEET_USERS_FILE` are read at startup by `auth.ts`. A per-user cap is
  therefore a bounded aggregate — roster size × cap × 1 MiB — not an
  open-ended one. This is what makes per-user scoping sufficient.
- **Module-scope mutable state leaks between tests.** The rate-limiting
  work hit exactly this: the throttle dedupe `Map` had to move out of
  module scope and into `rateLimitFor` because state survived across
  tests. A stream counter is worse — a leaked count fails the *next* test
  file's first open, at a distance from its cause.
- **The browser cannot see a failed upgrade's reason.** The WebSocket API
  surfaces a rejected handshake as an opaque `error` event. Any rejection
  the user should understand must happen *after* the upgrade, as a close
  frame with a reason — which `LogPanel` already renders beside the
  status.
- WS close reasons are capped at 123 bytes on the wire (`closeReason`
  already truncates to 120 for this reason).
- The route is a read path: audits fail **open**, per the audit policy.

## Design

A per-user counter of open streams, created per app instance, checked
after the origin check and before Docker is touched.

```
upgrade → session gate → id validation → origin check
        → tryAcquire(username) ──null──→ audit + close 1013
        → streamContainerLogs → audit → gate/forwarder wiring
        → socket "close" → release
```

### The unit

A new exported factory in `logs.ts`, beside `createSendGate`:

```ts
export function createStreamRegistry(): {
  tryAcquire: (key: string) => (() => void) | null;
};
```

`tryAcquire` returns a **release closure** on success and `null` at the
cap. Returning the closure rather than exposing a `release(key)` method
means a caller cannot release a slot it never took, and the closure owns
its own `released` flag, so a double call is a structural no-op rather
than something tests must catch. Backed by a `Map<string, number>` whose
entry is deleted at zero, so the map tracks *active* users rather than
everyone who has ever streamed.

Same shape as its neighbours — a factory over plain values, unit-testable
with no socket, no Fastify, no WebSocket.

### The cap

```ts
const MAX_STREAMS_PER_USER = 5;
```

A module constant alongside `HIGH_WATER` / `LOW_WATER`, matching how the
rate limits are hardcoded per route. Worst case 5 MiB of queued frames per
user.

The UI opens one log panel at a time, so 5 covers several browser tabs
with slack for two transients that are not user error: React StrictMode
double-mounts effects in dev, briefly holding two sockets for the same
container, and a socket dropped by a network blip holds its slot until the
server notices the peer is gone.

### Where the state lives

The registry is created inside `logsRoutes(app)` and closed over by the
handler — one registry per Fastify instance. Tests build a fresh app in
`beforeEach`, so the count resets with it. This is the shape the
rate-limiting dedupe map settled on, for the same reason (see
Constraints). Module scope is rejected as test-hostile; a separate
`streams.ts` module is rejected as overkill for ~25 lines with exactly one
consumer.

### Keying

```ts
request.session.get("user")?.username ?? request.ip
```

Identical to `rateLimitFor`'s `keyGenerator`, including the IP fallback —
unreachable behind the session gate, but keeps the unit safe if it is ever
applied to an open route.

Per user, not per session or per IP, for the same reason the rate limiter
chose it: operators behind one office NAT should not starve each other,
and the key then matches the audit `actor`.

### Placement and release

`tryAcquire` runs **after** the origin check and **before**
`streamContainerLogs`. A rejected stream must not cost a Docker call — the
existing rejection tests already assert
`expect(streamContainerLogs).not.toHaveBeenCalled()`, and this rejection
belongs in that set.

Release is wired three ways, all safe because the closure is idempotent:

1. `socket.on("close", release)` — the normal path, covering client
   disconnect, stream end (1000), and stream error (1011).
2. Explicitly on the `readyState !== OPEN` early return. This is the real
   leak case: if the client vanished while the stream was opening, `close`
   may already have fired and will never fire again, so the listener alone
   would strand the slot forever.
3. Explicitly in the `streamContainerLogs` catch, before the 1011 close.

### Behavior at the cap

```ts
socket.close(1013, `Too many concurrent log streams (max ${MAX_STREAMS_PER_USER})`);
```

39 bytes, well inside the 123-byte limit. 1013 ("Try again later") is the
capacity code; 1008 is already this route's policy-violation code
(invalid id, cross-origin), and a client should be able to tell "retry
later" from "never going to work". `LogPanel` renders `event.reason`
beside the status today, so the user sees the cap named with **no web
change**.

The new stream is rejected rather than an old one evicted. Eviction
self-heals a zombie slot, but lets a background tab silently kill the
panel the user is actively watching, and needs per-user ordered state
instead of a count.

### Auditing

One fail-open audit row per rejection, matching how cross-origin and
Docker failures already audit on this route:

```
action: "container.logs", outcome: "failure", target: <id>,
detail: "concurrent log stream limit reached (5)"
```

**No once-per-window dedupe**, unlike `auditThrottle`. This is a
deliberate trade-off: a client holding 5 streams open and looping on a
6th writes one row per attempt. Accepted because each rejection is a
distinct authenticated client decision and worth recording, and because
this route has no rate-limit window to hang a dedupe on. If audit volume
ever becomes a problem, the dedupe map pattern in `ratelimit.ts` drops in
unchanged.

## Alternatives rejected

- **Global process cap.** Bounds memory regardless of roster size, but
  one user with many tabs consumes the whole budget and locks everyone
  else out — the starvation case the rate limiter deliberately avoided by
  keying per user. The fixed roster already bounds the per-user aggregate.
- **Both per-user and global.** A strictly stronger backstop, and the
  right answer if the roster ever became dynamic. Rejected as YAGNI for a
  fixed config roster: a second counter, a second rejection reason, and
  more test surface for a bound the first counter already implies.
- **Reject at the HTTP upgrade with 429.** Reuses the `ApiError` shape
  from rate limiting and is tidier on the wire, but the browser cannot
  surface the reason (see Constraints), so the user would see a bare
  failure instead of a named cap.
- **Evict the oldest stream.** Covered above under Behavior at the cap.
- **Rate-limit stream opens instead.** Throttles the open *rate* but not
  the steady-state count: 5 opens/minute still reaches thousands of
  concurrent streams given time. Wrong control for the resource.

## Testing

Vitest, `server/test/`.

**New unit tests** for `createStreamRegistry`, no socket involved:

- allows acquisitions up to the cap
- returns `null` at the cap
- releasing frees exactly one slot, admitting the next acquire
- release is idempotent — calling it twice does not free two slots
- separate keys have independent budgets
- the map entry is dropped once a key's count returns to zero

**New integration tests** in `logs-routes.test.ts`, via `injectWS`. The
existing `mockLogStream()` helper resolves a single shared `PassThrough`;
these tests need `mockImplementation` returning a **fresh** stream per
call so that closing one socket does not destroy another's source.

- five concurrent opens all succeed; the sixth closes 1013 with the cap
  named, `streamContainerLogs` is not called for it, and one failure audit
  row is written
- closing one of the five admits a sixth
- a second user is unaffected while the first is at its cap

**Existing `logs-routes.test.ts` tests must stay green unmodified** —
each opens well under the cap, so any forced change there means the
registry altered normal-path behavior.

## Docs

One sentence in the README's log-streaming section, next to the drop-
behavior sentence added by PR #10, naming the cap and the close code.

No `types.ts` change, so `scripts/sync-types.mjs` does not run and the
`contract` CI job is unaffected. No dependency change, so no lockfile
regeneration.

## Out of scope

- A global/process-wide cap (see Alternatives rejected).
- Rate limiting the log route's open rate.
- `docker.ts`, the `LogStream` interface, the send gate itself.
- The web package: no client change, no new styling. `LogPanel` surfaces
  the close reason it already surfaces.
- Any cap on non-WS read routes.
