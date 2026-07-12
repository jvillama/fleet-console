# Deployment Workflow (Phase 3) — Design

> Status: approved 2026-07-11
> Prereq: container actions (PR #4) — role gates, fail-closed audit, rw socket.
> Scope note: the roadmap's Phase 3 line bundles two independent pieces; this
> spec covers the **in-app deployment workflow** only. CI/CD via GitHub
> Actions is deferred to its own spec (Phase 3.5).

## Goal

Deploy a new image tag to a single container from the dashboard: pull the
image, recreate the container with its existing configuration, watch it come
healthy, and offer one-click rollback to the previous image. Deploys are
admin-only, audited fail-closed, and tracked in a persistent deployment
history so rollback survives server restarts.

## Decisions (settled during brainstorming)

- **Target model:** one container per deploy. Container *groups* (rolling
  deploys across replicas) are a follow-up slice; the single-container
  mechanic must be proven first.
- **Tag selection:** free-text tag input. The repository part of the image
  reference is fixed — derived from the container's current image — so a
  deploy can change the tag only, never swap to an arbitrary image. No
  registry API integration; the daemon pulls whatever it can already reach
  (public images or registries the host is logged into). In-app registry
  credentials are out of scope.
- **Health watching:** if the container defines a HEALTHCHECK, wait for
  `healthy` (poll every 1 s, 60 s deadline). Without one, the container must
  still be running after a 10 s grace period. Failure surfaces a prominent
  rollback button — **no auto-rollback**; nothing reverts without an
  explicit admin action.
- **History:** a `deployments` table in the existing SQLite database. A
  rollback is just another deployment row (targeting the previous image)
  with `rollback_of` pointing at the row it reverts.
- **Authorization:** deploy and rollback require **admin** — changing what
  code runs is a step above start/stop/restart (operator). Reads of
  deployment state stay open to any authenticated session, consistent with
  current policy.
- **Execution model:** async job + polled status. `POST …/deploy` returns
  `202 { deploymentId }` immediately; the deploy advances a status column
  through its phases and the client polls `GET /api/deployments/:id` with
  the existing `usePolling` hook. No WebSocket, no job queue, no blocking
  HTTP (a pull can take minutes — longer than any sane proxy timeout).
- **Single-flight:** at most one active deployment per container; a second
  attempt gets `409`. A server restart mid-deploy marks the interrupted row
  `failed` ("interrupted by server restart") during startup.

## Shared types

Added to `server/src/types.ts` and mirrored verbatim in `web/src/types.ts`
(hand-mirrored contract rule; verify with the sync-types skill):

```ts
export type DeploymentStatus =
  | "pending"      // row created, pipeline not yet started
  | "pulling"      // pulling the new image
  | "recreating"   // stop old / rename / create + start new
  | "watching"     // health watch on the new container
  | "succeeded"
  | "failed";

export interface Deployment {
  id: number;
  containerId: string;      // container the deploy targeted (old id)
  containerName: string;
  oldImage: string;         // full ref before the deploy, e.g. nginx:1.27-alpine
  newImage: string;         // full ref deployed, e.g. nginx:1.28-alpine
  status: DeploymentStatus;
  detail: string | null;    // failure reason / phase notes
  actor: string;
  role: Role;
  rollbackOf: number | null;    // deployment id this rolls back, else null
  newContainerId: string | null; // set once the replacement container exists
  startedAt: string;        // ISO 8601
  finishedAt: string | null;
}

export interface DeployRequest {
  tag: string;
}

export interface DeployAccepted {
  deploymentId: number;
}

export interface DeploymentPage {
  deployments: Deployment[];
  total: number;
}
```

## Server

### Storage refactor — `server/src/db.ts` (new)

`audit.ts` is currently the only module touching better-sqlite3. Rather than
bloat it with deployment CRUD, the connection moves to a new `db.ts` that
owns better-sqlite3 exclusively and runs `PRAGMA user_version`-based
migrations at init:

- **Migration 1** — `CREATE TABLE IF NOT EXISTS audit_events (…)` exactly as
  today. `IF NOT EXISTS` lets pre-versioning databases (user_version 0 with
  an existing audit table) adopt the scheme without data loss.
- **Migration 2** — create `deployments` (schema below).

`initDb(path)` / `closeDb()` replace `initAudit(path)` / `closeAudit()` at
the app-lifecycle level; `audit.ts` and `deployments.ts` get the shared
handle from `db.ts` and keep owning their tables' SQL. This lands the
long-tracked "SQLite schema versioning before altering the audit table"
follow-up. CLAUDE.md's seam note changes to: *`db.ts` is the only module
that touches better-sqlite3; `audit.ts` and `deployments.ts` own their
tables through it.*

### Deployment store — `server/src/deployments.ts` (new)

```sql
CREATE TABLE deployments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  container_id      TEXT    NOT NULL,
  container_name    TEXT    NOT NULL,
  old_image         TEXT    NOT NULL,
  new_image         TEXT    NOT NULL,
  status            TEXT    NOT NULL,   -- DeploymentStatus
  detail            TEXT,
  actor             TEXT    NOT NULL,
  role              TEXT    NOT NULL,
  rollback_of       INTEGER,            -- references deployments(id)
  new_container_id  TEXT,
  started_at        TEXT    NOT NULL,
  finished_at       TEXT
);
```

Functions (all synchronous, better-sqlite3 style): `createDeployment`,
`updateDeploymentStatus(id, status, patch?)` (settles `detail`,
`new_container_id`, `finished_at` as phases advance), `getDeployment(id)`,
`queryDeployments({ container?, limit, offset })` (newest first, filtered by
container **name**), `findActiveDeployment(containerName)` (any non-terminal
status), and `failInterrupted()` — the startup sweep that marks every
non-terminal row `failed` / "interrupted by server restart".

A recreate gives the container a new id, so the id is a poor history key —
the **name** is the stable identity across deploys (recreate preserves it
and Docker enforces uniqueness). History queries and the single-flight guard
key on the name; ids are still recorded per row (`container_id`,
`new_container_id`) for audit fidelity.

### Docker seam — `server/src/docker.ts`

Stays the only module touching dockerode. Additions:

```ts
pullImage(ref: string): Promise<void>
// docker.pull + modem.followProgress; resolves when the pull completes.

inspectForRecreate(id: string): Promise<RecreateSpec>
// Captures name, image ref, Config (env, cmd, entrypoint, labels, exposed
// ports, healthcheck), HostConfig (binds, port bindings, restart policy,
// network mode, …), and per-network aliases/settings. RecreateSpec is
// server-internal, not mirrored.

recreateContainer(spec: RecreateSpec, newImage: string): Promise<string>
// stop old → rename old to `${name}-predeploy-${deploymentId}` → create new
// container with the original name, captured config, and newImage →
// connect extra networks → start. Returns the new container id.

removeContainer(id: string): Promise<void>          // cleanup of the renamed old container
renameContainer(id: string, name: string): Promise<void>  // restore path
watchHealth(id: string, opts): Promise<HealthOutcome>
// HEALTHCHECK present: inspect every 1 s until Health.Status is "healthy"
// (ok) or "unhealthy" / 60 s deadline (failed). No HEALTHCHECK: wait 10 s,
// then a single inspect — still "running" is ok, anything else failed.
```

If the container's `Config.Image` is a bare image id (`sha256:…`) with no
repository, deploy is refused with `422` — there is no repo to retag.

### Deploy engine — `server/src/deploy.ts` (new)

The pipeline orchestrator: composes the docker seam and the deployment
store; routes stay thin. Module-level single-flight `Map<containerName,
deploymentId>`, cross-checked against `findActiveDeployment` for belt and
braces.

Pipeline (runs detached after the route responds 202):

1. **`pulling`** — `pullImage(newRef)`. Runs *before* the running container
   is touched: a bad tag or unreachable registry fails here at zero
   downtime, with the old container never stopped.
2. **`recreating`** — `recreateContainer(spec, newRef)`. On any failure in
   this phase, restore the old container (rename back to its original name,
   start it if it was running) and mark the deployment `failed` with the
   underlying Docker error in `detail`. The restore is mechanical cleanup
   inside the same deploy — not a rollback, no new row.
3. **`watching`** — `watchHealth(newContainerId)`. On success → remove the
   renamed old container, settle `succeeded`. On failure → **leave the new
   container in place** (it may be worth debugging), settle `failed` with
   the health reason; the UI offers rollback.
4. Terminal state settles the audit row (below) and clears the
   single-flight entry.

The engine never throws to the route; every error lands in the deployment
row and the audit event.

### Routes — `server/src/routes/deployments.ts` (new)

| Route | Gate | Behaviour |
| --- | --- | --- |
| `POST /api/containers/:id/deploy` | session + **admin** | body `{ tag }`; validates id (same pattern as actions) and tag against Docker's tag grammar (`/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/`); derives `newImage` from the container's current repo; `409` if a deploy is active for this container; `422` if the tag equals the current tag (no-op deploy) or the image has no repo; returns `202 DeployAccepted` |
| `POST /api/deployments/:id/rollback` | session + **admin** | starts a new deployment targeting the row's `old_image`, `rollback_of` set; same 409/202 semantics; `404` unknown id; `422` if the container already runs `old_image` (no-op, mirroring the deploy route) |
| `GET /api/deployments/:id` | session (any role) | one `Deployment` row; `404` unknown |
| `GET /api/deployments?container=&limit=&offset=` | session (any role) | `DeploymentPage`, newest first, filtered by container **name**; limit clamped like the audit route |

Audit: fail-closed, exactly the actions.ts insert-then-update pattern —
`recordEvent` (`container.deploy` / `container.rollback`, provisional
failure/"incomplete") **before** the engine starts; audit unavailable ⇒
`503`, Docker untouched. Because the work is async, the row settles when the
pipeline reaches a terminal state, not when the HTTP response goes out —
`detail` records the final deployment status and image refs.

## Web

Plain hooks, no new libraries; `fetch`/polling patterns unchanged.

- **`api.ts`**: `deployContainer(id, tag)`, `rollbackDeployment(id)`,
  `getDeployment(id)`, `listDeployments(containerName)`.
- **RowActions** grows a **Deploy** button, rendered for admins only (same
  role prop already used to hide operator buttons from viewers). Clicking
  expands an inline tag input + confirm (reusing the two-click confirm
  pattern); confirm calls `deployContainer` and opens the DeployPanel.
- **DeployPanel** (new component, sibling of LogPanel): shows the active or
  most recent deployment for the selected container — phase progression
  (`pulling → recreating → watching → done`), image refs (old → new), actor,
  timestamps, and `detail` on failure. Driven by `usePolling` on
  `GET /api/deployments/:id` (~2 s) while non-terminal; polling stops on
  terminal states. Terminal `failed` and `succeeded` both render a
  **Roll back** button (admin only, inline confirm) wired to
  `rollbackDeployment`. Refresh-safe: state lives in SQLite, so reopening
  the panel resumes from the server's truth.

## Error handling & edge cases

- Pull failures, create failures, and health failures all land in
  `deployment.detail` and the audit outcome — no partial states invisible to
  the UI. Per-container degradation in list routes is untouched.
- **Compose drift** (documented, not solved): recreating a compose-managed
  container preserves its labels, but `docker compose` will see it as
  changed and may recreate it on the next `up`. README ops note.
- **Self-deploy** (documented, not solved): deploying fleet-console's own
  containers can kill the console mid-deploy. Consistent with the existing
  no-self-guard policy; README security note.
- Anonymous volumes: recreate carries over named binds/mounts from
  HostConfig; data in anonymous volumes not reflected there is lost with the
  old container — README ops note.

## Testing

- **Server** (Vitest, dockerode seam mocked, no daemon): engine state
  machine — happy path with and without HEALTHCHECK, pull failure (old
  container untouched), recreate failure (restore path), health timeout
  (new container left in place), startup sweep; route tests — role gates
  (viewer/operator `403`, admin `202`), tag validation, single-flight `409`,
  bare-image-id `422`, fail-closed `503` when the audit insert throws;
  rollback creates a correctly linked row. Fake timers drive the health
  watch; migration test covers adopting a pre-versioning audit DB.
- **Web** (Vitest + RTL, fetch stubbed at the boundary): Deploy button
  hidden for viewer/operator, shown for admin; tag input + confirm flow
  issues the POST; DeployPanel renders each phase from polled fixtures,
  stops polling on terminal state, and shows the rollback confirm flow.
- **Post-merge**: compose smoke test against a real daemon (deploy
  demo-nginx to another tag, watch it come healthy, roll back), mirroring
  the Phase 2 smoke test.

## README updates

Status line → Phase 3 (deployment workflow); endpoints table gains the four
routes; roadmap line splits — in-app deployment workflow ticked, CI/CD via
GitHub Actions remains unchecked as Phase 3.5; security notes gain the
self-deploy and compose-drift paragraphs; ops note about anonymous volumes.

## Out of scope (follow-up slices)

- Container groups / rolling deploys across replicas
- Registry tag listing and in-app registry credentials
- Auto-rollback on failed health
- CI/CD pipeline (GitHub Actions build → push → deploy) — Phase 3.5
- Rate limiting on mutating routes (tracked Phase 2 follow-up, still open)
- Configurable health deadlines / stop timeouts
