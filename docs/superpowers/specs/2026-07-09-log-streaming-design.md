# Live Log Streaming — Design

> Status: approved 2026-07-09
> Prereq: auth + audit log (merged in PR #1). Observe-only slice — the Docker
> socket mount stays `:ro`; streaming logs is a read.

## Goal

Click a container row on the dashboard and watch that container's logs live
in a slide-over panel, over a WebSocket, with the last 200 lines backfilled.
Every stream open is audited. This is the remaining observe-only half of
Phase 2 and establishes the streaming transport Phase 2's actions will reuse.

## Decisions (settled during brainstorming)

- **UI:** right-side slide-over panel above the dashboard (no router, no new
  view). One container at a time. `×` button and `Esc` close it.
- **Tail semantics:** open with the last 200 lines, then follow live.
  Auto-scroll pinned to bottom; scrolling up unpins; a "jump to latest"
  affordance re-pins. In-memory buffer capped at 2,000 lines (oldest drop).
- **Transport:** WebSocket via `@fastify/websocket`, route `GET /api/logs/:id`
  with `{ websocket: true }` — not SSE, not polling. The session cookie rides
  the HTTP upgrade request, so the existing `onRequest` gate applies with no
  new auth code.
- **Audit:** one event per stream open — `action: "container.logs"`,
  `target: <container id>`, actor/role from the session, `outcome: "success"`,
  client IP. Fail-open like all reads in this phase (log and continue).
- **No auto-reconnect** in this slice. A dead socket shows "disconnected";
  the panel keeps what it received. Reopen by re-clicking the row.
- **Stopped containers allowed:** Docker serves their historical logs; the
  stream ends when caught up and the panel shows "stream ended".

## Server

### Docker seam — `server/src/docker.ts`

`docker.ts` stays the only module touching dockerode. It gains one function:

```ts
streamContainerLogs(id: string, opts: { tail: number }): Promise<LogStream>
// LogStream = { stream: NodeJS.ReadableStream; close(): void }
```

- Calls `container.inspect()` first to read `Config.Tty`.
- TTY containers: `container.logs({ follow: true, stdout: true, stderr: true,
  tail })` is already plain text — pass it through.
- Non-TTY containers: the same call returns Docker's multiplexed format
  (8-byte frame headers); demux stdout+stderr into one `PassThrough` via
  `docker.modem.demuxStream`.
- `close()` destroys the underlying socket stream so the daemon stops
  following. Errors surface as `error` events on the returned stream.

### Route — `server/src/routes/logs.ts`

`logsRoutes(app)` registers `GET /api/logs/:id` with `{ websocket: true }`.

- **Auth:** the global gate already covers `/api/logs/...` (it is not in
  `OPEN_API_PATHS`); an unauthenticated upgrade gets the standard 401 before
  the handler runs. No role restriction in this slice (matches audit read).
- **Validation:** same container-id pattern as the stats route; invalid ids
  close the socket immediately with code `1008` and reason
  `"Invalid container id"` (the upgrade has already happened when a WS
  handler runs, so "reject" means close-with-reason).
- **Audit on open** (before streaming): `container.logs` event as decided
  above, wrapped in the same fail-open try/catch used by auth routes.
- **Streaming:** buffer chunks, split on `\n`, send one text frame per line;
  truncate lines over 8 KB. On Docker stream `end`, close the socket with
  code `1000`, reason `"stream ended"`. On stream `error` (e.g. no such
  container, daemon gone), close with code `1011` and the error message as
  the reason.
- **Cleanup:** client close/error → `close()` the LogStream. Server shutdown
  (`onClose`) closes naturally with the connections.

### Registration — `server/src/app.ts`

`await app.register(websocket)` (from `@fastify/websocket`) after the
rate-limit registration, then `await app.register(logsRoutes)` next to the
other routes. No gate changes, no type changes.

## Web

### API helper — `web/src/api.ts`

One addition:

```ts
logsSocketUrl(id: string): string
// (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host
//   + "/api/logs/" + id
```

No fetch-wrapper involvement: WS failures are handled by the panel, and a
401-rejected upgrade just looks like a failed connection (acceptable — the
rest of the UI notices the dead session on its next poll).

### Components

- **`web/src/components/LogPanel.tsx`** (new): props
  `{ container: ContainerSummary; onClose: () => void }`.
  - Opens the socket on mount, closes it on unmount / container change.
  - State: `lines: string[]` (capped at 2,000, oldest dropped),
    `status: "connecting" | "streaming" | "ended" | "disconnected"`
    (+ close reason when present).
  - Header: container name + shortId, status badge, `×` button. `Esc` closes
    (listener on `document` while mounted).
  - Body: monospace `<pre>`-style scroller. Pinned-to-bottom auto-scroll;
    unpin on manual scroll-up; "jump to latest" button re-pins.
- **`web/src/components/FleetTable.tsx`**: rows get `onClick` →
  `onSelect(container)` prop (and a pointer cursor). No other behavior
  change.
- **`web/src/App.tsx`** (`Console`): `selected: ContainerSummary | null`
  state; renders `<LogPanel>` when set (dashboard view only — switching to
  the Audit tab closes it).
- **`web/src/styles.css`**: slide-over panel styles (fixed right, full
  height, ~40% width min 480px, surface background, shadow), log line
  styles, status badge, jump-to-latest button.

## Proxies

- **`web/nginx.conf`**: WS upgrade support on the `/api/` location —
  `proxy_http_version 1.1`, `proxy_set_header Upgrade $http_upgrade`,
  `proxy_set_header Connection $connection_upgrade` with the standard
  `map $http_upgrade $connection_upgrade` block above the `server` block
  (conf.d files are included at http context, so `map` is legal there).
  Normal requests keep working (map yields `""` → header dropped).
- **`web/vite.config.ts`**: `ws: true` on the `/api` proxy entry.

## Testing

No Docker daemon, no real network beyond localhost. Existing suites keep
passing.

- **`server/test/docker.test.ts`** (extend): mock dockerode `getContainer` →
  `inspect` + `logs`; feed a `PassThrough`. Cover: TTY passthrough, non-TTY
  demux (via the mocked `modem.demuxStream`), `close()` destroying the
  source, tail option forwarded.
- **`server/test/logs-routes.test.ts`** (new): mock `../src/docker.js` (as
  routes.test.ts does) so `streamContainerLogs` returns a controllable
  `PassThrough`. Drive the WS route with `@fastify/websocket`'s injection
  support if available in the installed version, otherwise
  `app.listen({ port: 0 })` + the `ws` client package (dev-dependency).
  Cover:
  - unauthenticated upgrade → 401 (no handler run, no audit row)
  - authenticated open → audit row (`container.logs`, right target/actor/ip)
  - invalid id → close 1008, no docker call
  - pushed chunks arrive as per-line text frames (split + truncation)
  - source `end` → close 1000 "stream ended"; source `error` → close 1011
  - client close → `LogStream.close()` called
- **Web:** no test suite yet (unchanged); verification is typecheck + build
  + the compose smoke test.

## Out of scope (follow-ups)

- Auto-reconnect / backoff; multi-container tailing; log search, filtering,
  or download; timestamps toggle; dashboard live updates over WS; role
  restrictions on log access; Phase 2 mutating actions (which must audit
  fail-closed).
