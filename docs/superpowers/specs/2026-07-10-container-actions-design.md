# Container Actions (Phase 2) — Design

> Status: approved 2026-07-10
> Prereq: auth + audit (PR #1), log streaming (PR #2), web tests (PR #3).
> First mutating slice — the Docker socket mount changes from `:ro` to
> read-write, and the audit fail-closed policy promised in `audit.ts` lands.

## Goal

Start, stop, and restart containers from the dashboard. Actions are
restricted to operators and admins, every attempt is audited with a
fail-closed write (no audit record ⇒ no action), and the UI adds
lightweight inline confirmation for the disruptive actions.

## Decisions (settled during brainstorming)

- **Scope:** start / stop / restart only. Pause/unpause, kill, and remove
  are follow-up slices.
- **Authorization:** operator and admin may act; viewer stays read-only.
  Enforced server-side per route; the UI also hides action buttons from
  viewers.
- **Confirmation UX:** stop and restart require an inline two-click
  confirm (button flips to "Confirm stop?" for ~4 s); start fires
  immediately. No modal, no new library.
- **No self-guard:** the console can stop its own containers, same as
  `docker stop` can. Documented in the README as a known footgun instead
  of adding environment-sensitive self-detection logic.
- **API shape:** three explicit POST routes
  (`/api/containers/:id/start|stop|restart`) sharing one registration
  helper — not a generic `{ action }` endpoint, not an async job queue.
- **Fail-closed audit:** one row per action via insert-then-update (see
  below), keeping the audit page at one row per attempted action.

## Shared types

Added to `server/src/types.ts` and mirrored verbatim in
`web/src/types.ts` (hand-mirrored contract rule):

```ts
export type ContainerAction = "start" | "stop" | "restart";

export interface ContainerActionResult {
  id: string;
  action: ContainerAction;
  /** Container state after the action, from a post-action inspect. */
  state: ContainerState;
}
```

## Server

### Docker seam — `server/src/docker.ts`

Stays the only module touching dockerode. Three additions:

```ts
startContainer(id: string): Promise<ActionOutcome>
stopContainer(id: string): Promise<ActionOutcome>
restartContainer(id: string): Promise<ActionOutcome>
// ActionOutcome = { state: ContainerState; noOp: boolean }  (server-internal, not mirrored)
```

- Thin wrappers over `container.start() / stop() / restart()`, each
  followed by one `container.inspect()` to return the post-action state
  (so the UI can update the row without a full refetch).
- Stop/restart use Docker's default 10 s SIGTERM grace period — no
  timeout knob in this slice.
- Docker's "already in that state" response (HTTP 304 from start on a
  running container, or stop on a stopped one) is **success**: the
  desired state holds. The wrapper swallows the 304, still inspects, and
  reports `noOp: true` so the route can note it in the audit detail.

### Authorization — `server/src/authz.ts` (new)

Small role-gate helper, following the one-module-per-concern pattern:

```ts
requireRole(min: Role, audit: { action: string }): preHandler
// role order: viewer < operator < admin
```

- Reads `request.session.get("user")` (the global session gate in
  `app.ts` has already guaranteed it exists and is unexpired).
- On insufficient role: respond `403 { error: "Forbidden" }` **and
  record an audit event** (`outcome: "failure"`, `detail: "forbidden"`,
  `action` from the `audit` argument — `registerAction` passes e.g.
  `"container.stop"` — and `target` from `request.params.id`) — a
  viewer probing mutation endpoints is exactly what an audit log is
  for. This denial write is fail-open (log and continue): the action
  was refused anyway, so there is nothing to close against.
- The global session gate in `app.ts` is untouched.

### Fail-closed audit — `server/src/audit.ts`

`audit.ts` promised: mutating endpoints must refuse the action if the
audit write fails. The write must therefore happen **before** the Docker
call, but the outcome isn't known until after. Insert-then-update keeps
it to one row:

1. **Before** touching Docker: insert the row with `outcome: "failure"`,
   `detail: "incomplete"`. If the insert throws → respond
   `503 { error: "Audit log unavailable" }` and do **not** call Docker.
2. Run the Docker call.
3. Update the row to the real outcome — `success` (detail notes a no-op
   when the 304 path was taken), or `failure` with the error message. If
   the update throws, the row conservatively stays `failure "incomplete"`;
   log the discrepancy and still return the action's real result to the
   client (the action already happened; nothing to undo).

Two additions to `audit.ts` (still the only better-sqlite3 module):

```ts
recordEvent(event: NewAuditEvent): number   // now returns the rowid
updateEventOutcome(id: number, outcome: "success" | "failure", detail?: string): void
```

Existing fail-open callers (auth routes, log streaming) ignore the new
return value and are otherwise untouched. **Do not** change their
fail-open behavior.

Audit fields for actions: `action: "container.start" | "container.stop"
| "container.restart"`, `target: <container id as given>`, actor/role/ip
from the session and request, as auth events do today.

### Routes — `server/src/routes/actions.ts` (new)

`actionRoutes(app)` registers the three POSTs via one helper:

```ts
registerAction(app, "start",   startContainer);
registerAction(app, "stop",    stopContainer);
registerAction(app, "restart", restartContainer);
```

Each `POST /api/containers/:id/<action>` runs, in order:

1. **Id validation** — same `/^[a-zA-Z0-9._-]+$/` pattern as the stats
   route; reject with `400 { error: "Invalid container id" }`.
2. **Role gate** — `requireRole("operator")` preHandler (403 + audited
   denial as above).
3. **Fail-closed audit insert** — 503 on failure, Docker never called.
4. **Docker call** — on success, `200 ContainerActionResult`.
5. **Error mapping** — same shape as the stats route: 404
   `"Container not found"` for unknown ids, 502 with the daemon error
   in `detail` otherwise. Failures update the audit row accordingly.

Registered in `app.ts` next to the other route modules. The global
session gate covers the new paths automatically (401 unauthenticated).

## Web

### API helper — `web/src/api.ts`

One addition following the existing fetch-helper conventions:

```ts
containerAction(id: string, action: ContainerAction): Promise<ContainerActionResult>
// POST /api/containers/${id}/${action}
```

### Components

- **`web/src/components/FleetTable.tsx`** — rows gain an actions cell:
  - Start shown for `exited` / `created` / `dead`; Stop and Restart for
    `running` / `restarting`; nothing for `paused` / `removing` (out of
    scope states).
  - The whole cell renders only when the logged-in user's role is
    `operator` or `admin` (App already holds the session user from
    login; role is passed down as a prop).
  - Stop/Restart use the inline confirm: first click flips the button
    label to "Confirm stop?" / "Confirm restart?" for ~4 s
    (`useState` + timeout); second click fires; timeout or clicking
    elsewhere reverts. Start fires on first click.
  - In-flight: the row's buttons disable and the active one shows an
    ellipsis. On success, the row's state cell updates immediately from
    `ContainerActionResult.state`; the regular dashboard poll reconciles
    afterward.
  - Failure degrades per-row (matching the per-container "—" pattern):
    a short inline error message on that row, cleared on the next
    interaction or poll. No global banner.
- **`web/src/App.tsx`** — passes the session user's role down to
  `FleetTable`. No routing or state-library changes.
- **`web/src/styles.css`** — action button styles (including confirm
  and disabled states) and the row-level error text.

## Compose & docs

- **`docker-compose.yml`** — the socket mount drops `:ro`. Its comment
  is rewritten: the console can now start/stop/restart any container on
  the host **including itself and its own web proxy** — stopping the
  server container from the dashboard kills the console mid-request.
- **`README.md`** — security section updated to state the tradeoff and
  the mitigations honestly: read-write socket ⇒ root-equivalent access
  to the host, which is why actions require operator+, every attempt is
  audited fail-closed, and the console must never be exposed without
  the auth proxy in front.
- **`CLAUDE.md`** — Phase 1 "observe-only" gotcha replaced with the
  Phase 2 reality: socket is rw, mutating routes exist, fail-closed
  audit pattern documented for future mutating endpoints.
- No new environment variables.

## Testing

TDD per task; no Docker daemon needed (dockerode mocked as today);
existing suites keep passing.

- **`server/test/docker.test.ts`** (extend): start/stop/restart happy
  paths return post-inspect state; 304 treated as success; daemon error
  propagates.
- **`server/test/audit.test.ts`** (extend): `recordEvent` returns a
  usable rowid; `updateEventOutcome` rewrites outcome + detail; updating
  a missing id throws.
- **`server/test/actions-routes.test.ts`** (new, mock `../src/docker.js`
  and drive via `app.inject` + `loginAs()`):
  - 200 happy path per action, body is `ContainerActionResult`, audit
    row ends `success`
  - 401 without a session (no audit row, no docker call)
  - 403 as viewer — docker not called, denial audited
  - 400 invalid id (no audit row, no docker call)
  - 404 unknown container / 502 daemon error — audit row ends `failure`
    with detail
  - **503 when the audit insert throws — and the docker mock was never
    called** (the fail-closed assertion)
  - no-op (304) path returns success
- **`web/test/`** (boundary-stubbed fetch via `test/helpers.ts`, never
  module-mocking `../src/api`):
  - action buttons render per container state; viewer sees no actions
    cell
  - stop requires the two-click confirm; confirm state reverts after
    timeout
  - start fires immediately; correct POST URL hit
  - row state updates from the response; inline row error on failure

## Out of scope (follow-ups)

- Pause/unpause, kill, remove; stop-timeout configuration; bulk actions;
  self-protection guard for the console's own containers; audit-page
  filtering by action type; rate limiting on action routes; extracting
  the shared types package.
