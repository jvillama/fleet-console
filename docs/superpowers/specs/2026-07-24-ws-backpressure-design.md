# WebSocket Log-Stream Backpressure — Design

**Date:** 2026-07-24
**Status:** Approved
**Roadmap line:** Deferred backlog Tier 3 — "WS backpressure", the last
Tier 3 item after rate limiting shipped (PR #9)

## Problem

`server/src/routes/logs.ts` forwards every log line to the client with a
liveness check and nothing else:

```ts
const forwarder = createLineForwarder((line) => {
  if (socket.readyState === socket.OPEN) socket.send(line);
});
```

`socket.send()` on a slow client does not block — `ws` queues the frame in
memory and reports the backlog in `socket.bufferedAmount`. Nothing reads
that field. A container logging faster than a client can drain (a chatty
service, a client on a bad network, a laptop that slept with the panel
open) grows the per-socket queue without bound, in the server process,
for as long as the socket stays open. That is the failure mode this
change closes.

The gap was raised in the Phase-2 whole-branch review as "send
backpressure via `bufferedAmount` pause/resume + concurrent-stream cap"
and deferred to Tier 3.

## Constraints

- **The demux path cannot carry real backpressure without widening the
  docker seam.** `docker.ts` builds the non-TTY stream with
  `docker.modem.demuxStream(source, demuxed, demuxed)`, and dockerode's
  demuxer writes into the target without honoring `write()`'s return
  value. Pausing the returned `demuxed` PassThrough therefore does *not*
  stall the daemon — it just moves the growth into another buffer.
  Genuine pause/resume would have to reach `source`, which means adding
  pause/resume to the `LogStream` interface in `docker.ts`.
- **The client already discards data.** `web/src/components/LogPanel.tsx`
  keeps `MAX_LINES = 2000` and drops the oldest lines beyond that. Lines
  delivered to a client that is 100k lines behind are lines the browser
  will throw away on arrival. Lossless delivery has no consumer.
- The wire protocol is one text frame per line. There is no envelope,
  no message type — see `createLineForwarder`.
- The route is a read path. Reads audit **fail-open** and per-container
  failures degrade rather than propagate; a delivery-quality event should
  not become a security event or a stream teardown.
- `injectWS`'s fake duplex pair drains synchronously, so `bufferedAmount`
  is always 0 under test. Integration tests cannot drive this code path.

## Design

Drop-with-notification, gated on `bufferedAmount`, applied at the send
boundary inside `logs.ts`. `docker.ts`, `types.ts`, and the web package
are untouched.

```
docker stream → createLineForwarder(gate.send) → createSendGate(socket) → socket.send
                (existing: split/trim/truncate)   (new: drop when buffered)
```

A new exported factory `createSendGate(socket)` returns `{ send, finish }`
and closes over two pieces of state: a `dropped` count and a `suppressed`
flag. It mirrors `createLineForwarder` — a factory over a narrow callback
surface — so it unit-tests against a fake socket object with no WebSocket
and no Fastify involved.

### Thresholds

```ts
const HIGH_WATER = 1024 * 1024;  // 1 MiB queued → start dropping
const LOW_WATER = 256 * 1024;    // 256 KiB queued → resume sending
```

1 MiB is roughly 128 maximum-length lines (`MAX_LINE_CHARS` is 8192) or
several thousand typical ones — comfortably above any transient hiccup on
a healthy client, whose `bufferedAmount` sits near zero.

The two thresholds give hysteresis. With a single threshold, a client
hovering at the boundary alternates between dropping and sending on
nearly every line, producing a stream of "1 lines dropped" notices. The
gate stays suppressed until the queue has genuinely drained to a quarter
of the high-water mark.

### Send rules

- `readyState !== OPEN` → do nothing. Unchanged from today.
- **Suppressed and `bufferedAmount >= LOW_WATER`** → increment `dropped`,
  return.
- **Not suppressed and `bufferedAmount > HIGH_WATER`** → set `suppressed`,
  increment `dropped`, return.
- **Otherwise** → clear `suppressed`; if `dropped > 0`, send the notice
  frame first and reset the count; then send the line.

The notice is an ordinary text frame, indistinguishable on the wire from
container output:

```
⚠ 143 lines dropped (slow client)
```

`LogPanel` renders it as a normal log line. No client change, no protocol
change. A container that prints that exact text produces a confusing but
harmless duplicate.

### `finish()`

If the docker stream ends while the gate is suppressed, the pending count
would otherwise die unreported. The `end` handler calls
`forwarder.flush()`, then `gate.finish()`, then `socket.close(1000)`.
`finish()` sends the pending notice unconditionally — ignoring the
thresholds, since nothing more is coming — and is a no-op when nothing
was dropped. `ws.close()` queues behind pending data, so the frame still
reaches the client.

### Deliberate non-behaviors

- **No drain timer.** If a client is behind and the container goes quiet,
  the pending count waits for the next line rather than a poller. If no
  line ever arrives, the count dies with the socket. A timer per stream
  costs more than the information is worth.
- **No audit row for drops.** Delivery quality on a read path. The
  stream-open row already records who attached to what.
- **No close on overflow.** Memory is bounded by the gate, so there is no
  resource argument for killing a stream the user is watching.

## Alternatives rejected

- **Pause/resume the source stream.** Lossless, and the shape the Phase-2
  review originally suggested. Rejected: it requires adding pause/resume
  to `LogStream` in `docker.ts` (the demuxed PassThrough cannot carry it,
  per Constraints), it relocates unbounded growth into the source socket
  and the daemon rather than eliminating it, and it stalls a live log
  stream indefinitely for a client that has effectively gone away — while
  the browser would discard the backlog on arrival anyway.
- **Close the socket over a hard limit.** Strictly bounded and the
  smallest diff, but a transient hiccup on a chatty container tears down a
  stream the user is actively watching.
- **A styled notice line.** A marker the client detects and renders as
  console chrome rather than container output. Rejected as premature: it
  adds a wire-protocol marker, a web change, and a web test to make a rare
  message prettier.

## Testing

Vitest, `server/test/`. `injectWS` cannot produce a non-zero
`bufferedAmount` (see Constraints), so the gate is verified directly.

**New unit tests** for `createSendGate` against a fake socket
(`{ readyState, bufferedAmount, send }`):

- forwards lines untouched when the queue is clear
- suppresses and counts once `bufferedAmount` exceeds `HIGH_WATER`
- stays suppressed while the queue sits between `LOW_WATER` and
  `HIGH_WATER` (hysteresis)
- on resume below `LOW_WATER`, sends exactly one notice with the accurate
  count, ordered *before* the resumed line, and resets the count
- sends no notice when nothing was dropped
- sends nothing at all when `readyState !== OPEN`
- `finish()` sends a pending notice regardless of `bufferedAmount`
- `finish()` is a no-op when the count is zero

**Existing `logs-routes.test.ts` integration tests** are the wiring proof:
every forwarding, flush, and close assertion now runs through the gate and
must stay green **unmodified**. A change forced there means the gate
altered normal-path behavior, which it must not.

## Docs

One sentence in the README's log-streaming section describing the drop
behavior and the notice. No `types.ts` change, so `scripts/sync-types.mjs`
does not run and the `contract` CI job is unaffected. No dependency
change, so no lockfile regeneration.

## Out of scope

- **Concurrent-stream cap.** The other half of the Phase-2 review note.
  It addresses connection-count exhaustion, not memory growth, and brings
  its own policy questions (per-user vs global, behavior at the limit,
  whether a rejection is auditable). Tracked separately.
- `docker.ts`, the `LogStream` interface, and the TTY/demux split.
- The web package: no client change, no new styling.
- Read-route rate limiting, including any limit on log-stream opens.
