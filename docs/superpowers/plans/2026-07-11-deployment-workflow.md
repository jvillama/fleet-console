# Deployment Workflow (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a new image tag to a single container from the dashboard — pull, recreate with existing config, watch health, one-click rollback — admin-only, audited fail-closed, with history in SQLite.

**Architecture:** Async deploy + polled status. `POST /api/containers/:id/deploy` returns `202 { deploymentId }` immediately; an in-process pipeline advances a `deployments` row through `pending → pulling → recreating → watching → succeeded|failed`, and the SPA polls `GET /api/deployments/:id`. A rollback is another deployment row targeting the recorded previous image. better-sqlite3 moves from `audit.ts` into a new `db.ts` with `PRAGMA user_version` migrations.

**Tech Stack:** Fastify 5, dockerode, better-sqlite3, React 18, Vitest. **No new dependencies** — lockfiles must not change.

**Spec:** `docs/superpowers/specs/2026-07-11-deployment-workflow-design.md`

## Global Constraints

- Server uses NodeNext resolution: relative imports end in `.js` (e.g. `./db.js`). Web uses bundler resolution: extensionless imports.
- `server/src/types.ts` and `web/src/types.ts` are hand-mirrored — every change to one is copied verbatim to the other **in the same task**.
- `docker.ts` is the only module touching dockerode. After Task 1, `db.ts` is the only module touching better-sqlite3.
- Mutating routes: role-gate with `requireRole` from `authz.ts`; audit **fail-closed** via insert-then-update (`recordEvent` → act → `updateEventOutcome`). Reads and auth audit fail open.
- All commands run inside `server/` or `web/` — never the repo root.
- Commit messages: no Co-Authored-By trailer.
- Work on a branch: `git checkout -b deployment-workflow` before Task 1 if not already on it.
- Run `npm run typecheck` in the touched package before every commit.

---

### Task 1: `db.ts` — SQLite connection + user_version migrations

Extract the better-sqlite3 connection from `audit.ts` into a new `db.ts` that runs versioned migrations. Pure refactor plus migration mechanics — behavior of the audit store is unchanged.

**Files:**
- Create: `server/src/db.ts`
- Create: `server/test/db.test.ts`
- Modify: `server/src/audit.ts` (drop connection ownership)
- Modify: `server/src/app.ts:14,80-81` (init/close via db.ts)
- Modify: `server/test/audit.test.ts` (import initDb/closeDb)
- Modify: `server/test/actions-routes.test.ts:17,164` (closeAudit → closeDb)

**Interfaces:**
- Consumes: nothing new.
- Produces: `initDb(path: string): void`, `closeDb(): void`, `getDb(): Database.Database` (throws `"Database not initialized — call initDb() first"` when closed), `MIGRATIONS: string[]` (internal). Task 2 appends migration 2 to `MIGRATIONS`.

- [ ] **Step 1: Write the failing test**

Create `server/test/db.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { closeDb, getDb, initDb } from "../src/db.js";

let tmpDir: string | null = null;

afterEach(() => {
  closeDb();
  if (tmpDir !== null) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("initDb / migrations", () => {
  it("creates the audit table and stamps user_version on a fresh database", () => {
    initDb(":memory:");
    const version = getDb().pragma("user_version", { simple: true });
    expect(version).toBeGreaterThanOrEqual(1);
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("audit_events");
  });

  it("adopts a pre-versioning database without losing audit rows", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "fleet-db-"));
    const path = join(tmpDir, "audit.db");
    // Simulate a database created before migrations existed: audit_events
    // present, user_version still 0.
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE audit_events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      TEXT    NOT NULL,
        actor   TEXT    NOT NULL,
        role    TEXT,
        action  TEXT    NOT NULL,
        target  TEXT,
        outcome TEXT    NOT NULL,
        ip      TEXT,
        detail  TEXT
      );
    `);
    legacy
      .prepare(
        "INSERT INTO audit_events (ts, actor, action, outcome) VALUES (?, ?, ?, ?)",
      )
      .run("2026-07-01T00:00:00.000Z", "alice", "auth.login", "success");
    legacy.close();

    initDb(path);

    const rows = getDb().prepare("SELECT actor FROM audit_events").all() as {
      actor: string;
    }[];
    expect(rows).toEqual([{ actor: "alice" }]);
    expect(getDb().pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(1);
  });

  it("getDb throws before init and after close", () => {
    expect(() => getDb()).toThrow(/not initialized/);
    initDb(":memory:");
    closeDb();
    expect(() => getDb()).toThrow(/not initialized/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `server/`): `npx vitest run test/db.test.ts`
Expected: FAIL — cannot resolve `../src/db.js`.

- [ ] **Step 3: Create `server/src/db.ts`**

```ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * SQLite connection + schema migrations. This is the only module that
 * touches better-sqlite3 — audit.ts (and, from Phase 3, deployments.ts)
 * own their tables' SQL through the shared handle.
 *
 * Migrations run once at init and are tracked with PRAGMA user_version:
 * index i in MIGRATIONS is applied when user_version === i, then the
 * version is bumped to i + 1. Append-only — never edit a shipped entry.
 */

const MIGRATIONS: string[] = [
  // 1 — audit_events. IF NOT EXISTS lets databases created before schema
  // versioning (table present, user_version 0) adopt the scheme without
  // data loss.
  `CREATE TABLE IF NOT EXISTS audit_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT    NOT NULL,
    actor   TEXT    NOT NULL,
    role    TEXT,
    action  TEXT    NOT NULL,
    target  TEXT,
    outcome TEXT    NOT NULL,
    ip      TEXT,
    detail  TEXT
  );`,
];

let db: Database.Database | null = null;

export function initDb(path: string): void {
  closeDb();
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  migrate(db);
}

function migrate(d: Database.Database): void {
  const version = d.pragma("user_version", { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    d.exec(MIGRATIONS[v]!);
    d.pragma(`user_version = ${v + 1}`);
  }
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized — call initDb() first");
  return db;
}
```

- [ ] **Step 4: Refactor `server/src/audit.ts` to use the shared handle**

Replace the whole file header and connection plumbing. The file becomes:

```ts
import { getDb } from "./db.js";
import type { AuditEvent, AuditPage, Role } from "./types.js";

/**
 * Audit log storage. Table access lives here; the SQLite connection and
 * schema migrations live in db.ts (the only module touching better-sqlite3).
 *
 * recordEvent() throws on failure; callers choose the policy. Observe-only
 * callers fail open (log and continue). Mutating endpoints fail closed
 * (refuse the action if the write fails).
 */

export interface NewAuditEvent {
  actor: string;
  role: Role | null;
  action: string;
  outcome: "success" | "failure";
  target?: string;
  ip?: string;
  detail?: string;
}

export interface AuditQuery {
  limit: number;
  offset: number;
  actor?: string;
  action?: string;
}

export function recordEvent(event: NewAuditEvent): number {
  const result = getDb()
    .prepare(
      `INSERT INTO audit_events (ts, actor, role, action, target, outcome, ip, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      event.actor,
      event.role,
      event.action,
      event.target ?? null,
      event.outcome,
      event.ip ?? null,
      event.detail ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function queryEvents(q: AuditQuery): AuditPage {
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (q.actor) {
    where.push("actor = @actor");
    params.actor = q.actor;
  }
  if (q.action) {
    where.push("action = @action");
    params.action = q.action;
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const d = getDb();
  const total = (
    d.prepare(`SELECT COUNT(*) AS n FROM audit_events ${whereSql}`).get(params) as { n: number }
  ).n;
  const events = d
    .prepare(
      `SELECT id, ts, actor, role, action, target, outcome, ip, detail
       FROM audit_events ${whereSql}
       ORDER BY id DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: q.limit, offset: q.offset }) as AuditEvent[];
  return { events, total };
}

/**
 * Rewrites a previously inserted event's outcome (and detail). Used by the
 * fail-closed insert-then-update pattern: mutating routes insert the row as
 * a provisional failure before acting, then settle it here afterwards.
 */
export function updateEventOutcome(
  id: number,
  outcome: "success" | "failure",
  detail?: string,
): void {
  const result = getDb()
    .prepare(`UPDATE audit_events SET outcome = ?, detail = ? WHERE id = ?`)
    .run(outcome, detail ?? null, id);
  if (result.changes === 0) {
    throw new Error(`audit event ${id} not found`);
  }
}
```

(`initAudit`, `closeAudit`, `requireDb`, and the `Database`/`mkdirSync`/`dirname` imports are gone.)

- [ ] **Step 5: Update `server/src/app.ts`**

Replace the import on line 14:

```ts
import { closeDb, initDb } from "./db.js";
```

(delete `import { closeAudit, initAudit } from "./audit.js";`)

Replace lines 80–81:

```ts
  initDb(process.env.AUDIT_DB_PATH ?? "./data/audit.db");
  app.addHook("onClose", async () => closeDb());
```

- [ ] **Step 6: Update the two test files that owned the connection**

`server/test/audit.test.ts` — replace the import block (lines 1–8) with:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb } from "../src/db.js";
import { queryEvents, recordEvent, updateEventOutcome } from "../src/audit.js";
```

Then replace every `initAudit(":memory:")` with `initDb(":memory:")` and every `closeAudit()` with `closeDb()` (occurrences: `beforeEach`, `afterEach`, and inside the tests "throws when the store is closed" and "re-initializing gives a fresh store").

`server/test/actions-routes.test.ts` — line 17: change

```ts
import { closeAudit, queryEvents } from "../src/audit.js";
```

to

```ts
import { queryEvents } from "../src/audit.js";
import { closeDb } from "../src/db.js";
```

and in the fail-closed test (line 164), change `closeAudit();` to `closeDb();`.

- [ ] **Step 7: Run the full server suite and typecheck**

Run (in `server/`): `npm test` then `npm run typecheck`
Expected: all tests pass (98 existing + 3 new), typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add server/src/db.ts server/src/audit.ts server/src/app.ts server/test/db.test.ts server/test/audit.test.ts server/test/actions-routes.test.ts
git commit -m "refactor: extract SQLite connection into db.ts with user_version migrations"
```

---

### Task 2: Deployments store + shared contract types

Migration 2 (the `deployments` table), the `deployments.ts` CRUD module, and the API contract types in both mirrors.

**Files:**
- Modify: `server/src/db.ts` (append migration 2)
- Create: `server/src/deployments.ts`
- Create: `server/test/deployments.test.ts`
- Modify: `server/src/types.ts` (append Phase 3 block)
- Modify: `web/src/types.ts` (append identical block)

**Interfaces:**
- Consumes: `getDb()` from Task 1.
- Produces (used by Tasks 4–5):
  - Types: `DeploymentStatus`, `Deployment`, `DeployRequest`, `DeployAccepted`, `DeploymentPage` (both mirrors).
  - `createDeployment(d: NewDeployment): number` where `NewDeployment = { containerId; containerName; oldImage; newImage; actor; role; rollbackOf? }`
  - `updateDeploymentStatus(id: number, status: DeploymentStatus, patch?: { detail?: string; newContainerId?: string }): void` (throws on unknown id; stamps `finished_at` on terminal states)
  - `getDeployment(id: number): Deployment | null`
  - `queryDeployments(q: { container?: string; limit: number; offset: number }): DeploymentPage`
  - `findActiveDeployment(containerName: string): Deployment | null`
  - `failInterrupted(): number`

- [ ] **Step 1: Add the shared types to both mirrors**

Append to `server/src/types.ts` (after the Phase 2 block):

```ts
// --- Deployments (Phase 3, mirrored in web/src/types.ts) ---------------

export type DeploymentStatus =
  | "pending"      // row created, pipeline not yet started
  | "pulling"      // pulling the new image
  | "recreating"   // stop old / rename / create + start new
  | "watching"     // health watch on the new container
  | "succeeded"
  | "failed";

export interface Deployment {
  id: number;
  /** Container the deploy targeted (id before the recreate). */
  containerId: string;
  /** Stable identity across recreates — history and rollback key on this. */
  containerName: string;
  /** Full ref before the deploy, e.g. "nginx:1.27-alpine". */
  oldImage: string;
  /** Full ref deployed, e.g. "nginx:1.28-alpine". */
  newImage: string;
  status: DeploymentStatus;
  /** Failure reason or success summary. */
  detail: string | null;
  actor: string;
  role: Role;
  /** Deployment id this one rolls back, else null. */
  rollbackOf: number | null;
  /** Set once the replacement container exists. */
  newContainerId: string | null;
  startedAt: string; // ISO 8601
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

In `web/src/types.ts`, append the exact same block, but change the mirror note in the comment to `mirrored in server/src/types.ts`. (The `Role` type already exists in both files.)

- [ ] **Step 2: Append migration 2 in `server/src/db.ts`**

Add to the end of the `MIGRATIONS` array (after the audit_events entry):

```ts
  // 2 — deployments (Phase 3). One row per deploy attempt; a rollback is
  // another row with rollback_of set. container_name is the stable key
  // across recreates (a deploy changes the container id).
  `CREATE TABLE deployments (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id      TEXT    NOT NULL,
    container_name    TEXT    NOT NULL,
    old_image         TEXT    NOT NULL,
    new_image         TEXT    NOT NULL,
    status            TEXT    NOT NULL,
    detail            TEXT,
    actor             TEXT    NOT NULL,
    role              TEXT    NOT NULL,
    rollback_of       INTEGER,
    new_container_id  TEXT,
    started_at        TEXT    NOT NULL,
    finished_at       TEXT
  );`,
```

- [ ] **Step 3: Write the failing store test**

Create `server/test/deployments.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb } from "../src/db.js";
import {
  createDeployment,
  failInterrupted,
  findActiveDeployment,
  getDeployment,
  queryDeployments,
  updateDeploymentStatus,
} from "../src/deployments.js";

beforeEach(() => {
  initDb(":memory:");
});

afterEach(() => {
  closeDb();
});

function seed(overrides: Partial<Parameters<typeof createDeployment>[0]> = {}) {
  return createDeployment({
    containerId: "abc123",
    containerName: "web-1",
    oldImage: "nginx:1.27",
    newImage: "nginx:1.28",
    actor: "alice",
    role: "admin",
    ...overrides,
  });
}

describe("createDeployment / getDeployment", () => {
  it("round-trips a row with pending status and null optionals", () => {
    const id = seed();

    const dep = getDeployment(id);
    expect(dep).toMatchObject({
      id,
      containerId: "abc123",
      containerName: "web-1",
      oldImage: "nginx:1.27",
      newImage: "nginx:1.28",
      status: "pending",
      detail: null,
      actor: "alice",
      role: "admin",
      rollbackOf: null,
      newContainerId: null,
      finishedAt: null,
    });
    expect(dep?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("records rollback_of when given", () => {
    const first = seed();
    const second = seed({ rollbackOf: first, oldImage: "nginx:1.28", newImage: "nginx:1.27" });
    expect(getDeployment(second)?.rollbackOf).toBe(first);
  });

  it("returns null for an unknown id", () => {
    expect(getDeployment(999)).toBeNull();
  });
});

describe("updateDeploymentStatus", () => {
  it("advances status without finishing on non-terminal states", () => {
    const id = seed();
    updateDeploymentStatus(id, "pulling");
    expect(getDeployment(id)).toMatchObject({ status: "pulling", finishedAt: null });
  });

  it("stores the patch fields and stamps finished_at on terminal states", () => {
    const id = seed();
    updateDeploymentStatus(id, "watching", { newContainerId: "def456" });
    updateDeploymentStatus(id, "succeeded", { detail: "nginx:1.27 → nginx:1.28" });

    const dep = getDeployment(id);
    expect(dep).toMatchObject({
      status: "succeeded",
      newContainerId: "def456",
      detail: "nginx:1.27 → nginx:1.28",
    });
    expect(dep?.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("throws for an unknown id", () => {
    expect(() => updateDeploymentStatus(999, "failed")).toThrow(/not found/);
  });
});

describe("queryDeployments", () => {
  it("filters by container name, newest first, with totals", () => {
    seed({ containerName: "web-1" });
    seed({ containerName: "web-2" });
    const latest = seed({ containerName: "web-1", newImage: "nginx:1.29" });

    const page = queryDeployments({ container: "web-1", limit: 10, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.deployments[0]?.id).toBe(latest);
    expect(page.deployments.every((d) => d.containerName === "web-1")).toBe(true);
  });

  it("paginates", () => {
    for (let i = 0; i < 5; i++) seed();
    const page = queryDeployments({ limit: 2, offset: 2 });
    expect(page.total).toBe(5);
    expect(page.deployments).toHaveLength(2);
  });
});

describe("findActiveDeployment", () => {
  it("finds only non-terminal rows for the name", () => {
    const done = seed();
    updateDeploymentStatus(done, "succeeded");
    expect(findActiveDeployment("web-1")).toBeNull();

    const running = seed();
    updateDeploymentStatus(running, "pulling");
    expect(findActiveDeployment("web-1")?.id).toBe(running);
    expect(findActiveDeployment("other")).toBeNull();
  });
});

describe("failInterrupted", () => {
  it("fails every non-terminal row and leaves terminal rows alone", () => {
    const done = seed();
    updateDeploymentStatus(done, "succeeded", { detail: "ok" });
    const stuck = seed();
    updateDeploymentStatus(stuck, "recreating");

    const swept = failInterrupted();

    expect(swept).toBe(1);
    expect(getDeployment(stuck)).toMatchObject({
      status: "failed",
      detail: "interrupted by server restart",
    });
    expect(getDeployment(stuck)?.finishedAt).not.toBeNull();
    expect(getDeployment(done)).toMatchObject({ status: "succeeded", detail: "ok" });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run (in `server/`): `npx vitest run test/deployments.test.ts`
Expected: FAIL — cannot resolve `../src/deployments.js`.

- [ ] **Step 5: Create `server/src/deployments.ts`**

```ts
import { getDb } from "./db.js";
import type { Deployment, DeploymentPage, DeploymentStatus, Role } from "./types.js";

/**
 * Deployment history storage (Phase 3). One row per deploy attempt; the
 * deploy engine advances status through the pipeline and rollbacks are new
 * rows with rollback_of set. Keyed by container NAME for history queries —
 * a recreate changes the container id, the name survives.
 */

export interface NewDeployment {
  containerId: string;
  containerName: string;
  oldImage: string;
  newImage: string;
  actor: string;
  role: Role;
  rollbackOf?: number;
}

const TERMINAL: readonly DeploymentStatus[] = ["succeeded", "failed"];
const ACTIVE_SQL = "('pending', 'pulling', 'recreating', 'watching')";

interface Row {
  id: number;
  container_id: string;
  container_name: string;
  old_image: string;
  new_image: string;
  status: DeploymentStatus;
  detail: string | null;
  actor: string;
  role: Role;
  rollback_of: number | null;
  new_container_id: string | null;
  started_at: string;
  finished_at: string | null;
}

function toDeployment(r: Row): Deployment {
  return {
    id: r.id,
    containerId: r.container_id,
    containerName: r.container_name,
    oldImage: r.old_image,
    newImage: r.new_image,
    status: r.status,
    detail: r.detail,
    actor: r.actor,
    role: r.role,
    rollbackOf: r.rollback_of,
    newContainerId: r.new_container_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

const COLUMNS = `id, container_id, container_name, old_image, new_image, status,
  detail, actor, role, rollback_of, new_container_id, started_at, finished_at`;

export function createDeployment(d: NewDeployment): number {
  const result = getDb()
    .prepare(
      `INSERT INTO deployments
         (container_id, container_name, old_image, new_image, status,
          actor, role, rollback_of, started_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .run(
      d.containerId,
      d.containerName,
      d.oldImage,
      d.newImage,
      d.actor,
      d.role,
      d.rollbackOf ?? null,
      new Date().toISOString(),
    );
  return Number(result.lastInsertRowid);
}

export function updateDeploymentStatus(
  id: number,
  status: DeploymentStatus,
  patch: { detail?: string; newContainerId?: string } = {},
): void {
  const finishedAt = TERMINAL.includes(status) ? new Date().toISOString() : null;
  const result = getDb()
    .prepare(
      `UPDATE deployments
       SET status = ?,
           detail = COALESCE(?, detail),
           new_container_id = COALESCE(?, new_container_id),
           finished_at = COALESCE(?, finished_at)
       WHERE id = ?`,
    )
    .run(status, patch.detail ?? null, patch.newContainerId ?? null, finishedAt, id);
  if (result.changes === 0) {
    throw new Error(`deployment ${id} not found`);
  }
}

export function getDeployment(id: number): Deployment | null {
  const row = getDb()
    .prepare(`SELECT ${COLUMNS} FROM deployments WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? toDeployment(row) : null;
}

export function queryDeployments(q: {
  container?: string;
  limit: number;
  offset: number;
}): DeploymentPage {
  const whereSql = q.container !== undefined ? "WHERE container_name = @container" : "";
  const params: Record<string, string | number> = {};
  if (q.container !== undefined) params.container = q.container;

  const d = getDb();
  const total = (
    d.prepare(`SELECT COUNT(*) AS n FROM deployments ${whereSql}`).get(params) as { n: number }
  ).n;
  const rows = d
    .prepare(
      `SELECT ${COLUMNS} FROM deployments ${whereSql}
       ORDER BY id DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: q.limit, offset: q.offset }) as Row[];
  return { deployments: rows.map(toDeployment), total };
}

export function findActiveDeployment(containerName: string): Deployment | null {
  const row = getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM deployments
       WHERE container_name = ? AND status IN ${ACTIVE_SQL}
       ORDER BY id DESC LIMIT 1`,
    )
    .get(containerName) as Row | undefined;
  return row ? toDeployment(row) : null;
}

/**
 * Startup sweep: a server restart orphans in-flight pipelines, so any
 * non-terminal row is settled as failed. Returns the number swept.
 */
export function failInterrupted(): number {
  const result = getDb()
    .prepare(
      `UPDATE deployments
       SET status = 'failed', detail = 'interrupted by server restart', finished_at = ?
       WHERE status IN ${ACTIVE_SQL}`,
    )
    .run(new Date().toISOString());
  return result.changes;
}
```

- [ ] **Step 6: Run tests and typecheck (both packages — types changed in both)**

Run (in `server/`): `npx vitest run test/deployments.test.ts test/db.test.ts` then `npm run typecheck`
Run (in `web/`): `npm run typecheck`
Expected: PASS, both typechecks clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/db.ts server/src/deployments.ts server/src/types.ts server/test/deployments.test.ts web/src/types.ts
git commit -m "feat: deployments table, store module, and shared contract types"
```

---

### Task 3: Docker seam — pull, inspect-for-recreate, recreate, health watch

**Files:**
- Modify: `server/src/docker.ts` (append new functions)
- Create: `server/test/docker-deploy.test.ts`

**Interfaces:**
- Consumes: the existing module-level `docker` client and `toState`.
- Produces (used by Task 4):
  - `pullImage(ref: string): Promise<void>`
  - `inspectForRecreate(idOrName: string): Promise<RecreateSpec>` where `RecreateSpec = { id: string; name: string; image: string; wasRunning: boolean; createOptions: Docker.ContainerCreateOptions; extraNetworks: { name: string; aliases: string[] }[] }`
  - `recreateContainer(spec: RecreateSpec, newImage: string, deploymentId: number): Promise<string>` (returns new container id; restores the original on internal failure)
  - `removeContainer(id: string): Promise<void>`
  - `watchHealth(id: string): Promise<HealthOutcome>` where `HealthOutcome = { healthy: boolean; reason?: string }`

- [ ] **Step 1: Write the failing tests**

Create `server/test/docker-deploy.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// docker.ts creates its dockerode client at module load, so the mock must
// intercept the constructor before ../src/docker.js is imported.
const mockClient = vi.hoisted(() => ({
  listContainers: vi.fn(),
  getContainer: vi.fn(),
  createContainer: vi.fn(),
  getNetwork: vi.fn(),
  pull: vi.fn(),
  version: vi.fn(),
  info: vi.fn(),
  ping: vi.fn(),
  modem: { demuxStream: vi.fn(), followProgress: vi.fn() },
}));

vi.mock("dockerode", () => ({
  default: vi.fn(function () {
    return mockClient;
  }),
}));

import {
  inspectForRecreate,
  pullImage,
  recreateContainer,
  removeContainer,
  watchHealth,
  type RecreateSpec,
} from "../src/docker.js";

function inspectFixture(overrides: Record<string, unknown> = {}) {
  return {
    Id: "oldid1234567890",
    Name: "/web-1",
    State: { Status: "running", Running: true },
    Config: {
      Image: "nginx:1.27",
      Env: ["FOO=bar"],
      Cmd: ["nginx", "-g", "daemon off;"],
      Entrypoint: null,
      Labels: { "com.example": "1" },
      ExposedPorts: { "80/tcp": {} },
      WorkingDir: "",
      User: "",
    },
    HostConfig: {
      NetworkMode: "fleet_default",
      RestartPolicy: { Name: "unless-stopped" },
      Binds: ["vol:/data"],
    },
    NetworkSettings: {
      Networks: {
        fleet_default: { Aliases: ["web-1", "oldid1234567"] },
        backnet: { Aliases: ["web", "oldid1234567"] },
      },
    },
    ...overrides,
  };
}

function specFixture(overrides: Partial<RecreateSpec> = {}): RecreateSpec {
  return {
    id: "oldid1234567890",
    name: "web-1",
    image: "nginx:1.27",
    wasRunning: true,
    createOptions: { Env: ["FOO=bar"], HostConfig: { NetworkMode: "fleet_default" } },
    extraNetworks: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pullImage", () => {
  it("resolves when followProgress reports completion", async () => {
    const stream = {};
    mockClient.pull.mockResolvedValue(stream);
    mockClient.modem.followProgress.mockImplementation(
      (_s: unknown, done: (err: Error | null) => void) => done(null),
    );

    await expect(pullImage("nginx:1.28")).resolves.toBeUndefined();
    expect(mockClient.pull).toHaveBeenCalledWith("nginx:1.28");
  });

  it("rejects when the pull stream errors", async () => {
    mockClient.pull.mockResolvedValue({});
    mockClient.modem.followProgress.mockImplementation(
      (_s: unknown, done: (err: Error | null) => void) => done(new Error("manifest unknown")),
    );

    await expect(pullImage("nginx:bogus")).rejects.toThrow("manifest unknown");
  });
});

describe("inspectForRecreate", () => {
  it("captures name, image, running state, config, and extra networks", async () => {
    mockClient.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue(inspectFixture()),
    });

    const spec = await inspectForRecreate("web-1");

    expect(spec.id).toBe("oldid1234567890");
    expect(spec.name).toBe("web-1");
    expect(spec.image).toBe("nginx:1.27");
    expect(spec.wasRunning).toBe(true);
    expect(spec.createOptions.Env).toEqual(["FOO=bar"]);
    expect(spec.createOptions.HostConfig?.NetworkMode).toBe("fleet_default");
    // The NetworkMode network is attached at create; only others are extra,
    // and Docker's own short-id alias is dropped.
    expect(spec.extraNetworks).toEqual([{ name: "backnet", aliases: ["web"] }]);
  });
});

describe("recreateContainer", () => {
  function happyMocks() {
    const old = {
      stop: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const created = { id: "newid987", start: vi.fn().mockResolvedValue(undefined) };
    mockClient.getContainer.mockReturnValue(old);
    mockClient.createContainer.mockResolvedValue(created);
    const network = { connect: vi.fn().mockResolvedValue(undefined) };
    mockClient.getNetwork.mockReturnValue(network);
    return { old, created, network };
  }

  it("stops, renames, creates with the new image and original name, starts", async () => {
    const { old, created } = happyMocks();

    const newId = await recreateContainer(specFixture(), "nginx:1.28", 7);

    expect(newId).toBe("newid987");
    expect(old.stop).toHaveBeenCalled();
    expect(old.rename).toHaveBeenCalledWith({ name: "web-1-predeploy-7" });
    expect(mockClient.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({ name: "web-1", Image: "nginx:1.28", Env: ["FOO=bar"] }),
    );
    expect(created.start).toHaveBeenCalled();
  });

  it("skips stop for a container that was not running", async () => {
    const { old } = happyMocks();

    await recreateContainer(specFixture({ wasRunning: false }), "nginx:1.28", 7);

    expect(old.stop).not.toHaveBeenCalled();
  });

  it("swallows a 304 from stop (already stopped)", async () => {
    const { old } = happyMocks();
    old.stop.mockRejectedValue(Object.assign(new Error("not modified"), { statusCode: 304 }));

    await expect(recreateContainer(specFixture(), "nginx:1.28", 7)).resolves.toBe("newid987");
  });

  it("connects extra networks with their aliases before starting", async () => {
    const { network } = happyMocks();
    const spec = specFixture({ extraNetworks: [{ name: "backnet", aliases: ["web"] }] });

    await recreateContainer(spec, "nginx:1.28", 7);

    expect(mockClient.getNetwork).toHaveBeenCalledWith("backnet");
    expect(network.connect).toHaveBeenCalledWith({
      Container: "newid987",
      EndpointConfig: { Aliases: ["web"] },
    });
  });

  it("restores the original on create failure and rethrows", async () => {
    const { old } = happyMocks();
    mockClient.createContainer.mockRejectedValue(new Error("invalid mount"));

    await expect(recreateContainer(specFixture(), "nginx:1.28", 7)).rejects.toThrow(
      "invalid mount",
    );
    expect(old.rename).toHaveBeenLastCalledWith({ name: "web-1" });
    expect(old.start).toHaveBeenCalled(); // it was running before
  });

  it("removes the half-created container on start failure, then restores", async () => {
    const { old, created } = happyMocks();
    created.start.mockRejectedValue(new Error("oom"));
    const removeNew = vi.fn().mockResolvedValue(undefined);
    // getContainer is called for the old container first, then for cleanup
    // of the new one.
    mockClient.getContainer.mockImplementation((id: string) =>
      id === "newid987" ? { remove: removeNew } : old,
    );

    await expect(recreateContainer(specFixture(), "nginx:1.28", 7)).rejects.toThrow("oom");
    expect(removeNew).toHaveBeenCalledWith({ force: true });
    expect(old.rename).toHaveBeenLastCalledWith({ name: "web-1" });
  });
});

describe("removeContainer", () => {
  it("removes by id", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    mockClient.getContainer.mockReturnValue({ remove });

    await removeContainer("oldid");

    expect(remove).toHaveBeenCalled();
  });
});

describe("watchHealth", () => {
  function mockInspectSequence(states: Record<string, unknown>[]) {
    const inspect = vi.fn();
    for (const s of states) inspect.mockResolvedValueOnce({ State: s });
    inspect.mockResolvedValue({ State: states[states.length - 1] });
    mockClient.getContainer.mockReturnValue({ inspect });
    return inspect;
  }

  it("succeeds when a healthchecked container reports healthy", async () => {
    vi.useFakeTimers();
    mockInspectSequence([
      { Status: "running", Running: true, Health: { Status: "starting" } },
      { Status: "running", Running: true, Health: { Status: "healthy" } },
    ]);

    const promise = watchHealth("newid");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toEqual({ healthy: true });
  });

  it("fails as soon as the container reports unhealthy", async () => {
    vi.useFakeTimers();
    mockInspectSequence([
      { Status: "running", Running: true, Health: { Status: "starting" } },
      { Status: "running", Running: true, Health: { Status: "unhealthy" } },
    ]);

    const promise = watchHealth("newid");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toEqual({
      healthy: false,
      reason: "container reported unhealthy",
    });
  });

  it("fails when the 60s deadline passes without healthy", async () => {
    vi.useFakeTimers();
    mockInspectSequence([{ Status: "running", Running: true, Health: { Status: "starting" } }]);

    const promise = watchHealth("newid");
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(promise).resolves.toEqual({
      healthy: false,
      reason: "health check deadline (60s) exceeded",
    });
  });

  it("without a healthcheck, succeeds when still running after the grace period", async () => {
    vi.useFakeTimers();
    mockInspectSequence([
      { Status: "running", Running: true },
      { Status: "running", Running: true },
    ]);

    const promise = watchHealth("newid");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toEqual({ healthy: true });
  });

  it("without a healthcheck, fails when the container exited within the grace period", async () => {
    vi.useFakeTimers();
    mockInspectSequence([
      { Status: "running", Running: true },
      { Status: "exited", Running: false },
    ]);

    const promise = watchHealth("newid");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toEqual({
      healthy: false,
      reason: "container exited during 10s grace period",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `server/`): `npx vitest run test/docker-deploy.test.ts`
Expected: FAIL — `inspectForRecreate` etc. are not exported.

- [ ] **Step 3: Append the implementations to `server/src/docker.ts`**

Add at the end of the file:

```ts
// --- Phase 3: deployment workflow ---------------------------------------

/** Pull repo:tag through the daemon; resolves when the pull completes. */
export async function pullImage(ref: string): Promise<void> {
  const stream = await docker.pull(ref);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) =>
      err ? reject(err) : resolve(),
    );
  });
}

export interface RecreateSpec {
  id: string;
  /** Container name without the leading slash — stable across recreates. */
  name: string;
  /** Full image ref currently in use. */
  image: string;
  wasRunning: boolean;
  /** Create options carried over from the old container (sans name/Image). */
  createOptions: Docker.ContainerCreateOptions;
  /** Networks beyond HostConfig.NetworkMode, connected after create. */
  extraNetworks: { name: string; aliases: string[] }[];
}

/** Everything needed to recreate a container with a different image. */
export async function inspectForRecreate(idOrName: string): Promise<RecreateSpec> {
  const info = await docker.getContainer(idOrName).inspect();
  const name = info.Name.replace(/^\//, "");
  const networkMode = info.HostConfig.NetworkMode ?? "default";
  const networks = info.NetworkSettings?.Networks ?? {};
  const extraNetworks = Object.entries(networks)
    .filter(([netName]) => netName !== networkMode)
    .map(([netName, cfg]) => ({
      name: netName,
      // Docker adds a short-id alias of its own; a recreated container gets
      // a fresh one, so carrying the old id over would be wrong.
      aliases: (cfg.Aliases ?? []).filter((a) => !info.Id.startsWith(a)),
    }));

  return {
    id: info.Id,
    name,
    image: info.Config.Image,
    wasRunning: info.State.Running,
    createOptions: {
      Env: info.Config.Env,
      Cmd: info.Config.Cmd,
      Entrypoint: info.Config.Entrypoint,
      Labels: info.Config.Labels,
      ExposedPorts: info.Config.ExposedPorts,
      Healthcheck: info.Config.Healthcheck,
      WorkingDir: info.Config.WorkingDir || undefined,
      User: info.Config.User || undefined,
      HostConfig: info.HostConfig,
    },
    extraNetworks,
  };
}

/**
 * Replace a container with a copy running newImage: stop → rename (frees
 * the name) → create + start the replacement. If anything fails after the
 * rename, the original is renamed back (and restarted if it was running)
 * before the error propagates, so the fleet looks untouched. Returns the
 * new container's id.
 */
export async function recreateContainer(
  spec: RecreateSpec,
  newImage: string,
  deploymentId: number,
): Promise<string> {
  const old = docker.getContainer(spec.id);
  const parkedName = `${spec.name}-predeploy-${deploymentId}`;

  if (spec.wasRunning) {
    try {
      await old.stop();
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 304) throw err;
    }
  }
  await old.rename({ name: parkedName });

  let createdId: string | null = null;
  try {
    const created = await docker.createContainer({
      ...spec.createOptions,
      name: spec.name,
      Image: newImage,
    });
    createdId = created.id;
    for (const net of spec.extraNetworks) {
      await docker.getNetwork(net.name).connect({
        Container: created.id,
        EndpointConfig: net.aliases.length > 0 ? { Aliases: net.aliases } : {},
      });
    }
    await created.start();
    return created.id;
  } catch (err) {
    // Best-effort restore; the original error is the one worth surfacing.
    try {
      if (createdId !== null) {
        await docker.getContainer(createdId).remove({ force: true });
      }
      await old.rename({ name: spec.name });
      if (spec.wasRunning) await old.start();
    } catch {
      // Restore failed too — the original is still parked under parkedName;
      // the deployment's detail carries the primary error for the operator.
    }
    throw err;
  }
}

export async function removeContainer(id: string): Promise<void> {
  await docker.getContainer(id).remove();
}

export interface HealthOutcome {
  healthy: boolean;
  reason?: string;
}

const HEALTH_POLL_MS = 1000;
const HEALTH_DEADLINE_MS = 60_000;
const NO_HEALTHCHECK_GRACE_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Watch a freshly started container come up. With a HEALTHCHECK: poll until
 * Docker reports healthy (ok) or unhealthy / 60 s deadline (failed). Without
 * one: the container must still be running after a 10 s grace period.
 */
export async function watchHealth(id: string): Promise<HealthOutcome> {
  const container = docker.getContainer(id);
  const first = await container.inspect();

  if (first.State.Health === undefined) {
    await sleep(NO_HEALTHCHECK_GRACE_MS);
    const after = await container.inspect();
    return after.State.Running
      ? { healthy: true }
      : {
          healthy: false,
          reason: `container ${after.State.Status} during 10s grace period`,
        };
  }

  const deadline = Date.now() + HEALTH_DEADLINE_MS;
  let status: string = first.State.Health.Status;
  while (Date.now() < deadline) {
    if (status === "healthy") return { healthy: true };
    if (status === "unhealthy") {
      return { healthy: false, reason: "container reported unhealthy" };
    }
    await sleep(HEALTH_POLL_MS);
    status = (await container.inspect()).State.Health?.Status ?? "starting";
  }
  return { healthy: false, reason: "health check deadline (60s) exceeded" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (in `server/`): `npx vitest run test/docker-deploy.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Full suite, typecheck, commit**

Run (in `server/`): `npm test` then `npm run typecheck`
Expected: PASS, clean.

```bash
git add server/src/docker.ts server/test/docker-deploy.test.ts
git commit -m "feat: docker seam for deployments — pull, recreate, health watch"
```

---

### Task 4: Deploy engine — `deploy.ts`

The pipeline orchestrator: validates a deploy request, creates the deployment row, runs pull → recreate → watch detached from the HTTP request, settles the deployment row and the audit event at the terminal state, and enforces single-flight per container name.

**Files:**
- Create: `server/src/deploy.ts`
- Create: `server/test/deploy.test.ts`

**Interfaces:**
- Consumes: Task 2 store functions; Task 3 seam functions; `updateEventOutcome` from `audit.ts`.
- Produces (used by Task 5):
  - `parseImageRef(ref: string): { repo: string; tag: string } | null`
  - `requestDeploy(p: DeployRequestParams): Promise<DeployRequestOutcome>` where
    `DeployRequestParams = { container: string; tag?: string; image?: string; actor: string; role: Role; rollbackOf?: number; auditId: number; log: FastifyBaseLogger }` and
    `DeployRequestOutcome = { ok: true; deploymentId: number } | { ok: false; code: 404 | 409 | 422 | 502; error: string }`

- [ ] **Step 1: Write the failing tests**

Create `server/test/deploy.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/docker.js", () => ({
  getContainerStats: vi.fn(),
  getFleetOverview: vi.fn(),
  listContainers: vi.fn(),
  pingDocker: vi.fn(),
  streamContainerLogs: vi.fn(),
  startContainer: vi.fn(),
  stopContainer: vi.fn(),
  restartContainer: vi.fn(),
  pullImage: vi.fn(),
  inspectForRecreate: vi.fn(),
  recreateContainer: vi.fn(),
  removeContainer: vi.fn(),
  watchHealth: vi.fn(),
}));

import * as dockerApi from "../src/docker.js";
import { closeDb, initDb } from "../src/db.js";
import { queryEvents, recordEvent } from "../src/audit.js";
import { getDeployment } from "../src/deployments.js";
import { parseImageRef, requestDeploy } from "../src/deploy.js";
import type { RecreateSpec } from "../src/docker.js";

const mocked = vi.mocked(dockerApi);

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
  level: "silent",
} as never;

function spec(overrides: Partial<RecreateSpec> = {}): RecreateSpec {
  return {
    id: "oldid123",
    name: "web-1",
    image: "nginx:1.27",
    wasRunning: true,
    createOptions: {},
    extraNetworks: [],
    ...overrides,
  };
}

function auditRow(): number {
  return recordEvent({
    actor: "alice",
    role: "admin",
    action: "container.deploy",
    target: "web-1",
    outcome: "failure",
    detail: "incomplete",
  });
}

function baseParams(auditId: number) {
  return {
    container: "oldid123",
    tag: "1.28",
    actor: "alice",
    role: "admin" as const,
    auditId,
    log,
  };
}

async function waitForStatus(id: number, status: string): Promise<void> {
  await vi.waitFor(() => {
    expect(getDeployment(id)?.status).toBe(status);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  initDb(":memory:");
});

afterEach(() => {
  closeDb();
});

describe("parseImageRef", () => {
  it.each([
    ["nginx", { repo: "nginx", tag: "latest" }],
    ["nginx:1.27", { repo: "nginx", tag: "1.27" }],
    ["ghcr.io/acme/app:v2", { repo: "ghcr.io/acme/app", tag: "v2" }],
    ["localhost:5000/app", { repo: "localhost:5000/app", tag: "latest" }],
    ["nginx:1.27@sha256:abc", { repo: "nginx", tag: "1.27" }],
  ])("parses %s", (ref, expected) => {
    expect(parseImageRef(ref)).toEqual(expected);
  });

  it("returns null for bare image ids", () => {
    expect(parseImageRef("sha256:deadbeef")).toBeNull();
    expect(parseImageRef("0123456789abcdef")).toBeNull();
  });
});

describe("requestDeploy — validation", () => {
  it("404 when the container does not exist", async () => {
    mocked.inspectForRecreate.mockRejectedValue(
      Object.assign(new Error("no such container"), { statusCode: 404 }),
    );

    const result = await requestDeploy(baseParams(auditRow()));

    expect(result).toEqual({ ok: false, code: 404, error: "Container not found" });
  });

  it("502 when inspect fails for other reasons", async () => {
    mocked.inspectForRecreate.mockRejectedValue(new Error("socket hang up"));

    const result = await requestDeploy(baseParams(auditRow()));

    expect(result).toEqual({ ok: false, code: 502, error: "socket hang up" });
  });

  it("422 when the image has no repository to retag", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec({ image: "sha256:deadbeef" }));

    const result = await requestDeploy(baseParams(auditRow()));

    expect(result).toMatchObject({ ok: false, code: 422 });
  });

  it("422 when the container already runs the requested image", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());

    const result = await requestDeploy({ ...baseParams(auditRow()), tag: "1.27" });

    expect(result).toEqual({
      ok: false,
      code: 422,
      error: "Container already runs that image",
    });
  });

  it("409 while another deploy is active for the same container", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());
    // Park the first pipeline inside pullImage forever.
    let releasePull!: () => void;
    mocked.pullImage.mockReturnValue(new Promise((res) => (releasePull = () => res())));

    const first = await requestDeploy(baseParams(auditRow()));
    expect(first.ok).toBe(true);

    const second = await requestDeploy(baseParams(auditRow()));
    expect(second).toMatchObject({ ok: false, code: 409 });

    releasePull();
    mocked.recreateContainer.mockResolvedValue("newid987");
    mocked.watchHealth.mockResolvedValue({ healthy: true });
    mocked.removeContainer.mockResolvedValue(undefined);
    if (first.ok) await waitForStatus(first.deploymentId, "succeeded");
  });
});

describe("requestDeploy — pipeline", () => {
  function happyMocks() {
    mocked.inspectForRecreate.mockResolvedValue(spec());
    mocked.pullImage.mockResolvedValue(undefined);
    mocked.recreateContainer.mockResolvedValue("newid987");
    mocked.watchHealth.mockResolvedValue({ healthy: true });
    mocked.removeContainer.mockResolvedValue(undefined);
  }

  it("runs to succeeded, records ids and images, settles the audit row", async () => {
    happyMocks();
    const auditId = auditRow();

    const result = await requestDeploy(baseParams(auditId));
    expect(result).toEqual({ ok: true, deploymentId: expect.any(Number) });
    if (!result.ok) return;

    await waitForStatus(result.deploymentId, "succeeded");
    expect(getDeployment(result.deploymentId)).toMatchObject({
      containerName: "web-1",
      oldImage: "nginx:1.27",
      newImage: "nginx:1.28",
      newContainerId: "newid987",
      detail: "nginx:1.27 → nginx:1.28",
      rollbackOf: null,
    });
    expect(mocked.pullImage).toHaveBeenCalledWith("nginx:1.28");
    expect(mocked.removeContainer).toHaveBeenCalledWith("oldid123");
    const [event] = queryEvents({ limit: 1, offset: 0 }).events;
    expect(event).toMatchObject({ outcome: "success", detail: "nginx:1.27 → nginx:1.28" });
  });

  it("explicit image param is used verbatim (rollback path)", async () => {
    happyMocks();
    const result = await requestDeploy({
      container: "oldid123",
      image: "nginx:1.26",
      rollbackOf: 41,
      actor: "alice",
      role: "admin",
      auditId: auditRow(),
      log,
    });
    if (!result.ok) throw new Error("expected ok");

    await waitForStatus(result.deploymentId, "succeeded");
    expect(getDeployment(result.deploymentId)).toMatchObject({
      newImage: "nginx:1.26",
      rollbackOf: 41,
    });
    expect(mocked.pullImage).toHaveBeenCalledWith("nginx:1.26");
  });

  it("pull failure fails the deployment before the container is touched", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());
    mocked.pullImage.mockRejectedValue(new Error("manifest unknown"));
    const auditId = auditRow();

    const result = await requestDeploy(baseParams(auditId));
    if (!result.ok) throw new Error("expected ok");

    await waitForStatus(result.deploymentId, "failed");
    expect(getDeployment(result.deploymentId)?.detail).toBe("manifest unknown");
    expect(mocked.recreateContainer).not.toHaveBeenCalled();
    const [event] = queryEvents({ limit: 1, offset: 0 }).events;
    expect(event).toMatchObject({ outcome: "failure", detail: "manifest unknown" });
  });

  it("recreate failure fails the deployment with the docker error", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());
    mocked.pullImage.mockResolvedValue(undefined);
    mocked.recreateContainer.mockRejectedValue(new Error("invalid mount"));

    const result = await requestDeploy(baseParams(auditRow()));
    if (!result.ok) throw new Error("expected ok");

    await waitForStatus(result.deploymentId, "failed");
    expect(getDeployment(result.deploymentId)?.detail).toBe("invalid mount");
  });

  it("health failure fails the deployment but keeps the new container", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());
    mocked.pullImage.mockResolvedValue(undefined);
    mocked.recreateContainer.mockResolvedValue("newid987");
    mocked.watchHealth.mockResolvedValue({
      healthy: false,
      reason: "container reported unhealthy",
    });

    const result = await requestDeploy(baseParams(auditRow()));
    if (!result.ok) throw new Error("expected ok");

    await waitForStatus(result.deploymentId, "failed");
    expect(getDeployment(result.deploymentId)).toMatchObject({
      detail: "container reported unhealthy",
      newContainerId: "newid987",
    });
    expect(mocked.removeContainer).not.toHaveBeenCalled();
  });

  it("a new deploy is allowed after the previous one settles", async () => {
    happyMocks();
    const first = await requestDeploy(baseParams(auditRow()));
    if (!first.ok) throw new Error("expected ok");
    await waitForStatus(first.deploymentId, "succeeded");

    const second = await requestDeploy({ ...baseParams(auditRow()), tag: "1.29" });
    expect(second.ok).toBe(true);
    if (second.ok) await waitForStatus(second.deploymentId, "succeeded");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `server/`): `npx vitest run test/deploy.test.ts`
Expected: FAIL — cannot resolve `../src/deploy.js`.

- [ ] **Step 3: Create `server/src/deploy.ts`**

```ts
import type { FastifyBaseLogger } from "fastify";
import { updateEventOutcome } from "./audit.js";
import {
  createDeployment,
  findActiveDeployment,
  updateDeploymentStatus,
} from "./deployments.js";
import {
  inspectForRecreate,
  pullImage,
  recreateContainer,
  removeContainer,
  watchHealth,
  type RecreateSpec,
} from "./docker.js";
import type { Role } from "./types.js";

/**
 * Deployment pipeline (Phase 3). requestDeploy validates and creates the
 * deployment row, then runs pull → recreate → watch detached from the HTTP
 * request. Progress lands in the deployments table; the audit row (inserted
 * fail-closed by the route before calling here) settles at the terminal
 * state. Single-flight per container NAME — the stable identity across
 * recreates.
 */

export type DeployRequestOutcome =
  | { ok: true; deploymentId: number }
  | { ok: false; code: 404 | 409 | 422 | 502; error: string };

export interface DeployRequestParams {
  /** Container id or name — anything the Docker API accepts. */
  container: string;
  /** New tag on the container's current repo. Ignored when image is set. */
  tag?: string;
  /** Full image ref to deploy — the rollback path. */
  image?: string;
  actor: string;
  role: Role;
  rollbackOf?: number;
  /** Audit row already inserted (provisional failure) by the route. */
  auditId: number;
  log: FastifyBaseLogger;
}

/**
 * Split repo:tag, tolerating registry ports and dropping digests. Null when
 * there is no repository to retag (bare image ids).
 */
export function parseImageRef(ref: string): { repo: string; tag: string } | null {
  if (ref.startsWith("sha256:") || /^[0-9a-f]{12,64}$/.test(ref)) return null;
  const base = ref.split("@")[0]!;
  const slash = base.lastIndexOf("/");
  const colon = base.lastIndexOf(":");
  if (colon > slash) return { repo: base.slice(0, colon), tag: base.slice(colon + 1) };
  return { repo: base, tag: "latest" };
}

const active = new Map<string, number>(); // container name → deployment id

export async function requestDeploy(p: DeployRequestParams): Promise<DeployRequestOutcome> {
  let spec: RecreateSpec;
  try {
    spec = await inspectForRecreate(p.container);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { ok: false, code: 404, error: "Container not found" };
    }
    return {
      ok: false,
      code: 502,
      error: err instanceof Error ? err.message : "Docker inspect failed",
    };
  }

  let newImage: string;
  if (p.image !== undefined) {
    newImage = p.image;
  } else {
    const parsed = parseImageRef(spec.image);
    if (parsed === null) {
      return { ok: false, code: 422, error: "Container image has no repository to retag" };
    }
    newImage = `${parsed.repo}:${p.tag}`;
  }
  if (newImage === spec.image) {
    return { ok: false, code: 422, error: "Container already runs that image" };
  }

  if (active.has(spec.name) || findActiveDeployment(spec.name) !== null) {
    return {
      ok: false,
      code: 409,
      error: "A deployment is already active for this container",
    };
  }

  const deploymentId = createDeployment({
    containerId: spec.id,
    containerName: spec.name,
    oldImage: spec.image,
    newImage,
    actor: p.actor,
    role: p.role,
    ...(p.rollbackOf !== undefined ? { rollbackOf: p.rollbackOf } : {}),
  });
  active.set(spec.name, deploymentId);
  void runPipeline(deploymentId, spec, newImage, p.auditId, p.log);
  return { ok: true, deploymentId };
}

async function runPipeline(
  deploymentId: number,
  spec: RecreateSpec,
  newImage: string,
  auditId: number,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    updateDeploymentStatus(deploymentId, "pulling");
    await pullImage(newImage);

    updateDeploymentStatus(deploymentId, "recreating");
    const newContainerId = await recreateContainer(spec, newImage, deploymentId);

    updateDeploymentStatus(deploymentId, "watching", { newContainerId });
    const health = await watchHealth(newContainerId);
    if (!health.healthy) {
      // The replacement stays up for debugging; rollback is one click away.
      settle(deploymentId, auditId, "failed", health.reason ?? "health check failed", log);
      return;
    }

    try {
      await removeContainer(spec.id);
    } catch (err) {
      log.warn({ err, container: spec.id }, "parked container cleanup failed");
    }
    settle(deploymentId, auditId, "succeeded", `${spec.image} → ${newImage}`, log);
  } catch (err) {
    settle(
      deploymentId,
      auditId,
      "failed",
      err instanceof Error ? err.message : "deployment failed",
      log,
    );
  } finally {
    active.delete(spec.name);
  }
}

function settle(
  deploymentId: number,
  auditId: number,
  status: "succeeded" | "failed",
  detail: string,
  log: FastifyBaseLogger,
): void {
  try {
    updateDeploymentStatus(deploymentId, status, { detail });
  } catch (err) {
    log.error({ err, deploymentId }, "deployment status update failed");
  }
  try {
    updateEventOutcome(auditId, status === "succeeded" ? "success" : "failure", detail);
  } catch (err) {
    // Same policy as actions.ts settleAudit: the work already happened,
    // nothing to undo — the row conservatively stays a provisional failure.
    log.error({ err, auditId }, "audit outcome update failed");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (in `server/`): `npx vitest run test/deploy.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Full suite, typecheck, commit**

Run (in `server/`): `npm test` then `npm run typecheck`
Expected: PASS, clean.

```bash
git add server/src/deploy.ts server/test/deploy.test.ts
git commit -m "feat: deployment pipeline engine with single-flight and audit settlement"
```

---

### Task 5: Deployment routes + app wiring

**Files:**
- Create: `server/src/routes/deployments.ts`
- Create: `server/test/deployments-routes.test.ts`
- Modify: `server/src/app.ts` (register routes, startup sweep)

**Interfaces:**
- Consumes: `requestDeploy` (Task 4), `getDeployment`/`queryDeployments`/`failInterrupted` (Task 2), `recordEvent`/`updateEventOutcome`, `requireRole`.
- Produces: `deploymentsRoutes(app: FastifyInstance): Promise<void>` and the four HTTP endpoints of the spec.

- [ ] **Step 1: Write the failing tests**

Create `server/test/deployments-routes.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/docker.js", () => ({
  getContainerStats: vi.fn(),
  getFleetOverview: vi.fn(),
  listContainers: vi.fn(),
  pingDocker: vi.fn(),
  streamContainerLogs: vi.fn(),
  startContainer: vi.fn(),
  stopContainer: vi.fn(),
  restartContainer: vi.fn(),
  pullImage: vi.fn(),
  inspectForRecreate: vi.fn(),
  recreateContainer: vi.fn(),
  removeContainer: vi.fn(),
  watchHealth: vi.fn(),
}));

import * as dockerApi from "../src/docker.js";
import { buildApp } from "../src/app.js";
import { queryEvents } from "../src/audit.js";
import { closeDb } from "../src/db.js";
import {
  createDeployment,
  getDeployment,
  updateDeploymentStatus,
} from "../src/deployments.js";
import type { RecreateSpec } from "../src/docker.js";
import { loginAs } from "./helpers.js";

const mocked = vi.mocked(dockerApi);

let app: FastifyInstance;
let admin: { session: string };

function spec(overrides: Partial<RecreateSpec> = {}): RecreateSpec {
  return {
    id: "oldid123",
    name: "web-1",
    image: "nginx:1.27",
    wasRunning: true,
    createOptions: {},
    extraNetworks: [],
    ...overrides,
  };
}

function happyDockerMocks() {
  mocked.inspectForRecreate.mockResolvedValue(spec());
  mocked.pullImage.mockResolvedValue(undefined);
  mocked.recreateContainer.mockResolvedValue("newid987");
  mocked.watchHealth.mockResolvedValue({ healthy: true });
  mocked.removeContainer.mockResolvedValue(undefined);
}

function deploy(
  body: unknown = { tag: "1.28" },
  cookies: { session: string } = admin,
  id = "oldid123",
) {
  return app.inject({
    method: "POST",
    url: `/api/containers/${id}/deploy`,
    payload: body as Record<string, unknown>,
    cookies,
  });
}

async function waitForStatus(id: number, status: string): Promise<void> {
  await vi.waitFor(() => {
    expect(getDeployment(id)?.status).toBe(status);
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  app = await buildApp();
  admin = await loginAs(app, "alice", "correct horse");
});

afterEach(async () => {
  await app.close();
});

describe("POST /api/containers/:id/deploy", () => {
  it("202 for admins; row reaches succeeded; audit settles with actor and target", async () => {
    happyDockerMocks();

    const res = await deploy();

    expect(res.statusCode).toBe(202);
    const { deploymentId } = res.json() as { deploymentId: number };
    await waitForStatus(deploymentId, "succeeded");
    const [event] = queryEvents({ limit: 1, offset: 0, action: "container.deploy" }).events;
    expect(event).toMatchObject({
      actor: "alice",
      role: "admin",
      target: "oldid123",
      outcome: "success",
      ip: expect.any(String),
    });
  });

  it("401 without a session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/containers/oldid123/deploy",
      payload: { tag: "1.28" },
    });
    expect(res.statusCode).toBe(401);
    expect(mocked.inspectForRecreate).not.toHaveBeenCalled();
  });

  it.each([
    ["viewer", "bob", "battery staple"],
    ["operator", "carol", "staple correct"],
  ])("403 for %s roles, with an audited denial", async (_role, user, password) => {
    const cookies = await loginAs(app, user, password);

    const res = await deploy(undefined, cookies);

    expect(res.statusCode).toBe(403);
    expect(mocked.inspectForRecreate).not.toHaveBeenCalled();
    const [event] = queryEvents({ limit: 1, offset: 0, action: "container.deploy" }).events;
    expect(event).toMatchObject({ actor: user, outcome: "failure", detail: "forbidden" });
  });

  it("400 for a malformed tag, before any audit write or docker call", async () => {
    const res = await deploy({ tag: "bad tag!" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid image tag" });
    expect(mocked.inspectForRecreate).not.toHaveBeenCalled();
    expect(queryEvents({ limit: 5, offset: 0, action: "container.deploy" }).total).toBe(0);
  });

  it("400 for an invalid container id", async () => {
    const res = await deploy(undefined, admin, "bad$id");
    expect(res.statusCode).toBe(400);
  });

  it("404 when the container does not exist, audit settled as failure", async () => {
    mocked.inspectForRecreate.mockRejectedValue(
      Object.assign(new Error("no such container"), { statusCode: 404 }),
    );

    const res = await deploy();

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Container not found" });
    const [event] = queryEvents({ limit: 1, offset: 0, action: "container.deploy" }).events;
    expect(event).toMatchObject({ outcome: "failure", detail: "Container not found" });
  });

  it("422 when the container already runs the requested tag", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());

    const res = await deploy({ tag: "1.27" });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "Container already runs that image" });
  });

  it("409 while a deploy is active for the container", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());
    let releasePull!: () => void;
    mocked.pullImage.mockReturnValue(new Promise((res) => (releasePull = () => res())));

    const first = await deploy();
    expect(first.statusCode).toBe(202);

    const second = await deploy();
    expect(second.statusCode).toBe(409);

    mocked.recreateContainer.mockResolvedValue("newid987");
    mocked.watchHealth.mockResolvedValue({ healthy: true });
    mocked.removeContainer.mockResolvedValue(undefined);
    releasePull();
    const { deploymentId } = first.json() as { deploymentId: number };
    await waitForStatus(deploymentId, "succeeded");
  });

  it("fails closed: 503 when the audit write fails, docker never touched", async () => {
    closeDb();

    const res = await deploy();

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "Audit log unavailable" });
    expect(mocked.inspectForRecreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/deployments/:id/rollback", () => {
  function seedFinished(): number {
    const id = createDeployment({
      containerId: "oldid123",
      containerName: "web-1",
      oldImage: "nginx:1.27",
      newImage: "nginx:1.28",
      actor: "alice",
      role: "admin",
    });
    updateDeploymentStatus(id, "succeeded", { newContainerId: "newid987" });
    return id;
  }

  it("202 starts a linked deployment targeting the old image", async () => {
    const sourceId = seedFinished();
    // The current container (post-deploy) runs 1.28; rollback goes to 1.27.
    mocked.inspectForRecreate.mockResolvedValue(spec({ image: "nginx:1.28" }));
    mocked.pullImage.mockResolvedValue(undefined);
    mocked.recreateContainer.mockResolvedValue("newerid555");
    mocked.watchHealth.mockResolvedValue({ healthy: true });
    mocked.removeContainer.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: `/api/deployments/${sourceId}/rollback`,
      cookies: admin,
    });

    expect(res.statusCode).toBe(202);
    const { deploymentId } = res.json() as { deploymentId: number };
    await waitForStatus(deploymentId, "succeeded");
    expect(getDeployment(deploymentId)).toMatchObject({
      newImage: "nginx:1.27",
      rollbackOf: sourceId,
    });
    expect(mocked.inspectForRecreate).toHaveBeenCalledWith("web-1");
    const [event] = queryEvents({ limit: 1, offset: 0, action: "container.rollback" }).events;
    expect(event).toMatchObject({ outcome: "success", target: "web-1" });
  });

  it("404 for an unknown deployment id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/deployments/999/rollback",
      cookies: admin,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Deployment not found" });
  });

  it("422 when the container already runs the rollback image", async () => {
    const sourceId = seedFinished();
    mocked.inspectForRecreate.mockResolvedValue(spec({ image: "nginx:1.27" }));

    const res = await app.inject({
      method: "POST",
      url: `/api/deployments/${sourceId}/rollback`,
      cookies: admin,
    });
    expect(res.statusCode).toBe(422);
  });

  it("403 for operators", async () => {
    const sourceId = seedFinished();
    const carol = await loginAs(app, "carol", "staple correct");

    const res = await app.inject({
      method: "POST",
      url: `/api/deployments/${sourceId}/rollback`,
      cookies: carol,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/deployments", () => {
  it("returns one deployment by id, 404 when unknown", async () => {
    const id = createDeployment({
      containerId: "a",
      containerName: "web-1",
      oldImage: "nginx:1.27",
      newImage: "nginx:1.28",
      actor: "alice",
      role: "admin",
    });

    const ok = await app.inject({ url: `/api/deployments/${id}`, cookies: admin });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id, containerName: "web-1", status: "pending" });

    const missing = await app.inject({ url: "/api/deployments/999", cookies: admin });
    expect(missing.statusCode).toBe(404);
  });

  it("lists deployments filtered by container name, any role", async () => {
    for (const name of ["web-1", "web-2", "web-1"]) {
      createDeployment({
        containerId: "a",
        containerName: name,
        oldImage: "nginx:1.27",
        newImage: "nginx:1.28",
        actor: "alice",
        role: "admin",
      });
    }
    const viewer = await loginAs(app, "bob", "battery staple");

    const res = await app.inject({
      url: "/api/deployments?container=web-1&limit=10",
      cookies: viewer,
    });

    expect(res.statusCode).toBe(200);
    const page = res.json() as { deployments: { containerName: string }[]; total: number };
    expect(page.total).toBe(2);
    expect(page.deployments.every((d) => d.containerName === "web-1")).toBe(true);
  });
});

describe("startup sweep", () => {
  it("marks rows left non-terminal by a previous process as failed on boot", async () => {
    // :memory: gives every buildApp a fresh database, so a real restart
    // needs a file-backed one.
    const tmpDir = mkdtempSync(join(tmpdir(), "fleet-deploy-"));
    const prevPath = process.env.AUDIT_DB_PATH;
    process.env.AUDIT_DB_PATH = join(tmpDir, "audit.db");
    try {
      const app1 = await buildApp();
      const id = createDeployment({
        containerId: "a",
        containerName: "web-1",
        oldImage: "nginx:1.27",
        newImage: "nginx:1.28",
        actor: "alice",
        role: "admin",
      });
      updateDeploymentStatus(id, "watching");
      await app1.close();

      const app2 = await buildApp(); // restart — sweep runs during build
      expect(getDeployment(id)).toMatchObject({
        status: "failed",
        detail: "interrupted by server restart",
      });
      await app2.close();
    } finally {
      process.env.AUDIT_DB_PATH = prevPath;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `server/`): `npx vitest run test/deployments-routes.test.ts`
Expected: FAIL — the deploy routes 404 (not registered).

- [ ] **Step 3: Create `server/src/routes/deployments.ts`**

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { recordEvent, updateEventOutcome } from "../audit.js";
import { requireRole } from "../authz.js";
import { requestDeploy } from "../deploy.js";
import { getDeployment, queryDeployments } from "../deployments.js";
import type { ApiError, DeployAccepted, DeployRequest } from "../types.js";

/**
 * Phase 3 deployment routes. The two POSTs audit FAIL-CLOSED like
 * actions.ts: the event row is inserted (provisional failure) before any
 * Docker access, and the request is refused with 503 if that insert fails.
 * Because the pipeline is async, the row settles when the deployment
 * reaches a terminal state — not when the 202 goes out.
 */

const ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
// Docker tag grammar: word char start, then word chars, dots, dashes.
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function settleAudit(
  request: FastifyRequest,
  auditId: number,
  outcome: "success" | "failure",
  detail?: string,
): void {
  try {
    updateEventOutcome(auditId, outcome, detail);
  } catch (err) {
    request.log.error({ err, auditId }, "audit outcome update failed");
  }
}

function insertAuditOr503(
  request: FastifyRequest,
  reply: FastifyReply,
  action: string,
  target: string,
): number | null {
  const user = request.session.get("user")!;
  try {
    return recordEvent({
      actor: user.username,
      role: user.role,
      action,
      target,
      outcome: "failure",
      detail: "incomplete",
      ip: request.ip,
    });
  } catch (err) {
    request.log.error({ err }, "audit write failed — refusing deployment");
    const body: ApiError = { error: "Audit log unavailable" };
    void reply.code(503).send(body);
    return null;
  }
}

export async function deploymentsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: DeployRequest }>(
    "/api/containers/:id/deploy",
    {
      preHandler: [
        async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
          if (!ID_PATTERN.test(request.params.id)) {
            const body: ApiError = { error: "Invalid container id" };
            return reply.code(400).send(body);
          }
        },
        requireRole("admin", { action: "container.deploy" }),
      ],
    },
    async (request, reply) => {
      const { id } = request.params;
      const tag = (request.body as Partial<DeployRequest> | null)?.tag;
      if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
        const body: ApiError = { error: "Invalid image tag" };
        return reply.code(400).send(body);
      }

      const user = request.session.get("user")!;
      const auditId = insertAuditOr503(request, reply, "container.deploy", id);
      if (auditId === null) return;

      const result = await requestDeploy({
        container: id,
        tag,
        actor: user.username,
        role: user.role,
        auditId,
        log: request.log,
      });
      if (!result.ok) {
        settleAudit(request, auditId, "failure", result.error);
        const body: ApiError = { error: result.error };
        return reply.code(result.code).send(body);
      }
      const body: DeployAccepted = { deploymentId: result.deploymentId };
      return reply.code(202).send(body);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/deployments/:id/rollback",
    { preHandler: [requireRole("admin", { action: "container.rollback" })] },
    async (request, reply) => {
      const depId = Number(request.params.id);
      if (!Number.isInteger(depId) || depId < 1) {
        const body: ApiError = { error: "Invalid deployment id" };
        return reply.code(400).send(body);
      }
      const source = getDeployment(depId);
      if (source === null) {
        const body: ApiError = { error: "Deployment not found" };
        return reply.code(404).send(body);
      }

      const user = request.session.get("user")!;
      const auditId = insertAuditOr503(
        request,
        reply,
        "container.rollback",
        source.containerName,
      );
      if (auditId === null) return;

      const result = await requestDeploy({
        container: source.containerName,
        image: source.oldImage,
        actor: user.username,
        role: user.role,
        rollbackOf: source.id,
        auditId,
        log: request.log,
      });
      if (!result.ok) {
        settleAudit(request, auditId, "failure", result.error);
        const body: ApiError = { error: result.error };
        return reply.code(result.code).send(body);
      }
      const body: DeployAccepted = { deploymentId: result.deploymentId };
      return reply.code(202).send(body);
    },
  );

  app.get<{ Params: { id: string } }>("/api/deployments/:id", async (request, reply) => {
    const depId = Number(request.params.id);
    const dep = Number.isInteger(depId) && depId >= 1 ? getDeployment(depId) : null;
    if (dep === null) {
      const body: ApiError = { error: "Deployment not found" };
      return reply.code(404).send(body);
    }
    return dep;
  });

  app.get<{ Querystring: { container?: string; limit?: string; offset?: string } }>(
    "/api/deployments",
    async (request) => {
      const rawLimit = Number(request.query.limit ?? 50);
      const rawOffset = Number(request.query.offset ?? 0);
      const query: { container?: string; limit: number; offset: number } = {
        limit: Number.isFinite(rawLimit)
          ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200)
          : 50,
        offset: Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0,
      };
      if (request.query.container) query.container = request.query.container;
      return queryDeployments(query);
    },
  );
}
```

- [ ] **Step 4: Wire into `server/src/app.ts`**

Add imports (with the other route imports):

```ts
import { deploymentsRoutes } from "./routes/deployments.js";
import { failInterrupted } from "./deployments.js";
```

After the `initDb(...)` line, add the startup sweep:

```ts
  initDb(process.env.AUDIT_DB_PATH ?? "./data/audit.db");
  // A restart orphans any in-flight deployment pipeline — settle the rows.
  const swept = failInterrupted();
  if (swept > 0) {
    app.log.warn({ swept }, "settled deployments interrupted by restart");
  }
```

Register the routes after `logsRoutes`:

```ts
  await app.register(deploymentsRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

Run (in `server/`): `npx vitest run test/deployments-routes.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 6: Full server suite, typecheck, commit**

Run (in `server/`): `npm test` then `npm run typecheck`
Expected: PASS, clean.

```bash
git add server/src/routes/deployments.ts server/src/app.ts server/test/deployments-routes.test.ts
git commit -m "feat: deployment routes — deploy, rollback, status, history"
```

---

### Task 6: Web UI — deploy button, DeployPanel, API helpers

**Files:**
- Modify: `web/src/api.ts` (four helpers)
- Modify: `web/src/components/RowActions.tsx` (deploy button + tag form, new props)
- Modify: `web/src/components/FleetTable.tsx` (thread new props)
- Create: `web/src/components/DeployPanel.tsx`
- Modify: `web/src/App.tsx` (panel state, footer version)
- Modify: `web/src/styles.css` (small additions)
- Modify: `web/test/FleetTable.test.tsx` (new required prop)
- Create: `web/test/DeployPanel.test.tsx`
- Create: `web/test/RowActionsDeploy.test.tsx`

**Interfaces:**
- Consumes: `Deployment`, `DeployAccepted`, `DeploymentPage`, `DeployRequest` types (Task 2); the four HTTP endpoints (Task 5); `usePolling`, `stubFetch`, `jsonResponse`, `deferred` helpers.
- Produces:
  - `api.deployContainer(id: string, tag: string): Promise<DeployAccepted>`
  - `api.getDeployment(id: number): Promise<Deployment>`
  - `api.listDeployments(container: string, limit?: number): Promise<DeploymentPage>`
  - `api.rollbackDeployment(id: number): Promise<DeployAccepted>`
  - `RowActions` new props: `role: Role`, `onDeployStarted: (container: ContainerSummary, deploymentId: number) => void`
  - `FleetTable` new prop: `onDeployStarted` (same signature)
  - `DeployPanel` props: `{ container: ContainerSummary; deploymentId: number; role: Role; onClose: () => void }`

- [ ] **Step 1: Add the API helpers**

In `web/src/api.ts`, extend the type import to include the new types:

```ts
import type {
  AuditPage,
  ContainerAction,
  ContainerActionResult,
  ContainerStats,
  ContainerSummary,
  DeployAccepted,
  Deployment,
  DeploymentPage,
  DeployRequest,
  FleetOverview,
  SessionUser,
} from "./types";
```

Add to the `api` object (after `containerAction`):

```ts
  deployContainer: (id: string, tag: string) =>
    request<DeployAccepted>(`/api/containers/${id}/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag } satisfies DeployRequest),
    }),
  getDeployment: (id: number) => getJson<Deployment>(`/api/deployments/${id}`),
  listDeployments: (container: string, limit = 20) =>
    getJson<DeploymentPage>(
      `/api/deployments?container=${encodeURIComponent(container)}&limit=${limit}`,
    ),
  rollbackDeployment: (id: number) =>
    request<DeployAccepted>(`/api/deployments/${id}/rollback`, { method: "POST" }),
```

- [ ] **Step 2: Write the failing RowActions deploy tests**

Create `web/test/RowActionsDeploy.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RowActions } from "../src/components/RowActions";
import type { ContainerSummary } from "../src/types";
import { jsonResponse, stubFetch } from "./helpers";

const container: ContainerSummary = {
  id: "abc123",
  shortId: "abc123",
  name: "web-1",
  image: "nginx:1.27",
  state: "running",
  status: "Up 2 hours",
  createdAt: "2026-07-01T00:00:00.000Z",
  ports: [],
};

function renderRow(role: "admin" | "operator", onDeployStarted = vi.fn()) {
  render(
    <table>
      <tbody>
        <tr>
          <td>
            <RowActions
              container={container}
              state="running"
              role={role}
              onStateChange={vi.fn()}
              onDeployStarted={onDeployStarted}
            />
          </td>
        </tr>
      </tbody>
    </table>,
  );
  return onDeployStarted;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function user() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
}

describe("RowActions deploy flow", () => {
  it("shows Deploy only for admins", () => {
    renderRow("operator");
    expect(screen.queryByRole("button", { name: "Deploy" })).toBeNull();
    cleanup();
    renderRow("admin");
    expect(screen.getByRole("button", { name: "Deploy" })).toBeInTheDocument();
  });

  it("expands to a tag input; confirm POSTs and reports the deployment id", async () => {
    const { calls } = stubFetch({
      "/api/containers/abc123/deploy": jsonResponse({ deploymentId: 7 }, 202),
    });
    const onDeployStarted = renderRow("admin");
    const u = user();

    await u.click(screen.getByRole("button", { name: "Deploy" }));
    await u.type(screen.getByPlaceholderText("new tag"), "1.28");
    await u.click(screen.getByRole("button", { name: "Deploy tag" }));

    expect(calls[0]?.url).toBe("/api/containers/abc123/deploy");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ tag: "1.28" });
    expect(onDeployStarted).toHaveBeenCalledWith(container, 7);
  });

  it("confirm is disabled until a tag is typed, and Cancel collapses the form", async () => {
    renderRow("admin");
    const u = user();

    await u.click(screen.getByRole("button", { name: "Deploy" }));
    expect(screen.getByRole("button", { name: "Deploy tag" })).toBeDisabled();

    await u.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText("new tag")).toBeNull();
  });

  it("shows the error and keeps the form when the request fails", async () => {
    stubFetch({
      "/api/containers/abc123/deploy": jsonResponse({ error: "conflict" }, 409),
    });
    const onDeployStarted = renderRow("admin");
    const u = user();

    await u.click(screen.getByRole("button", { name: "Deploy" }));
    await u.type(screen.getByPlaceholderText("new tag"), "1.28");
    await u.click(screen.getByRole("button", { name: "Deploy tag" }));

    expect(onDeployStarted).not.toHaveBeenCalled();
    expect(screen.getByText(/HTTP 409/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run (in `web/`): `npx vitest run test/RowActionsDeploy.test.tsx`
Expected: FAIL — `role`/`onDeployStarted` props do not exist.

- [ ] **Step 4: Extend `RowActions.tsx`**

Update the imports and the component (full replacement of the props block and additions inside the component):

```tsx
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type {
  ContainerAction,
  ContainerState,
  ContainerSummary,
  Role,
} from "../types";
```

New props signature:

```tsx
export function RowActions({
  container,
  state,
  role,
  onStateChange,
  onDeployStarted,
}: {
  container: ContainerSummary;
  /** Effective state — the table may already be showing a post-action override. */
  state: ContainerState;
  role: Role;
  onStateChange: (id: string, state: ContainerState) => void;
  onDeployStarted: (container: ContainerSummary, deploymentId: number) => void;
}) {
```

Add deploy state after the existing `useState` calls:

```tsx
  const [deploying, setDeploying] = useState(false);
  const [tag, setTag] = useState("");
  const [deployBusy, setDeployBusy] = useState(false);
```

Add the deploy handler after `fire`:

```tsx
  async function fireDeploy(): Promise<void> {
    setDeployBusy(true);
    setError(null);
    try {
      const res = await api.deployContainer(container.id, tag.trim());
      setDeploying(false);
      setTag("");
      onDeployStarted(container, res.deploymentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deploy failed");
    } finally {
      setDeployBusy(false);
    }
  }
```

Change the early return so admins always get the deploy button:

```tsx
  const actions = availableActions(state);
  if (actions.length === 0 && error === null && role !== "admin") return null;
```

Inside the returned `<span className="row-actions">`, after the `actions.map(...)` block and before the error span, add:

```tsx
      {role === "admin" && !deploying && (
        <button
          className="action"
          disabled={busy !== null || deployBusy}
          onClick={(e) => {
            e.stopPropagation();
            setDeploying(true);
            setError(null);
          }}
        >
          Deploy
        </button>
      )}
      {role === "admin" && deploying && (
        <span className="deploy-form" onClick={(e) => e.stopPropagation()}>
          <input
            className="deploy-tag"
            placeholder="new tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          />
          <button
            className="action confirm"
            disabled={deployBusy || tag.trim() === ""}
            onClick={() => void fireDeploy()}
          >
            {deployBusy ? "…" : "Deploy tag"}
          </button>
          <button
            className="action"
            disabled={deployBusy}
            onClick={() => {
              setDeploying(false);
              setTag("");
            }}
          >
            Cancel
          </button>
        </span>
      )}
```

- [ ] **Step 5: Thread props through `FleetTable.tsx`**

Add `onDeployStarted` to the props:

```tsx
export function FleetTable({
  containers,
  role,
  onSelect,
  onDeployStarted,
}: {
  containers: ContainerSummary[];
  role: Role;
  onSelect: (container: ContainerSummary) => void;
  onDeployStarted: (container: ContainerSummary, deploymentId: number) => void;
}) {
```

Pass both to `RowActions`:

```tsx
                  <RowActions
                    container={c}
                    state={state}
                    role={role}
                    onStateChange={(id, next) =>
                      setStateOverrides((prev) => ({ ...prev, [id]: next }))
                    }
                    onDeployStarted={onDeployStarted}
                  />
```

In `web/test/FleetTable.test.tsx`, add `onDeployStarted={vi.fn()}` to every `<FleetTable …/>` render (the prop is required).

- [ ] **Step 6: Run the RowActions deploy tests**

Run (in `web/`): `npx vitest run test/RowActionsDeploy.test.tsx test/FleetTable.test.tsx`
Expected: PASS.

- [ ] **Step 7: Write the failing DeployPanel tests**

Create `web/test/DeployPanel.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeployPanel } from "../src/components/DeployPanel";
import type { ContainerSummary, Deployment } from "../src/types";
import { jsonResponse, stubFetch } from "./helpers";

const container: ContainerSummary = {
  id: "abc123",
  shortId: "abc123",
  name: "web-1",
  image: "nginx:1.27",
  state: "running",
  status: "Up 2 hours",
  createdAt: "2026-07-01T00:00:00.000Z",
  ports: [],
};

function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: 7,
    containerId: "abc123",
    containerName: "web-1",
    oldImage: "nginx:1.27",
    newImage: "nginx:1.28",
    status: "pulling",
    detail: null,
    actor: "alice",
    role: "admin",
    rollbackOf: null,
    newContainerId: null,
    startedAt: "2026-07-11T20:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function renderPanel(role: "admin" | "viewer" = "admin", onClose = vi.fn()) {
  render(
    <DeployPanel container={container} deploymentId={7} role={role} onClose={onClose} />,
  );
  return onClose;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function user() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
}

describe("DeployPanel", () => {
  it("shows the current phase and image transition while in flight", async () => {
    stubFetch({ "/api/deployments/7": deployment({ status: "recreating" }) });
    renderPanel();

    expect(await screen.findByText("nginx:1.27 → nginx:1.28")).toBeInTheDocument();
    expect(screen.getByText("recreating")).toHaveClass("current");
    expect(screen.getByText("pulling")).toHaveClass("done");
    expect(screen.getByText("watching")).toHaveClass("pending");
  });

  it("polls until terminal, then stops fetching and shows the outcome", async () => {
    let status: Deployment["status"] = "pulling";
    const { calls } = stubFetch({
      "/api/deployments/7": () => jsonResponse(deployment({ status })),
    });
    renderPanel();

    expect(await screen.findByText("pulling")).toBeInTheDocument();

    status = "succeeded";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(await screen.findByText("Deployment succeeded")).toBeInTheDocument();

    const countAtTerminal = calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(calls.length).toBe(countAtTerminal);
  });

  it("shows the failure detail and a rollback confirm for admins", async () => {
    stubFetch({
      "/api/deployments/7": deployment({
        status: "failed",
        detail: "container reported unhealthy",
      }),
    });
    renderPanel("admin");

    expect(
      await screen.findByText(/Deployment failed — container reported unhealthy/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Roll back" })).toBeInTheDocument();
  });

  it("hides rollback from non-admins", async () => {
    stubFetch({ "/api/deployments/7": deployment({ status: "failed", detail: "x" }) });
    renderPanel("viewer");

    await screen.findByText(/Deployment failed/);
    expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull();
  });

  it("rollback confirm starts the new deployment and follows it", async () => {
    stubFetch({
      "/api/deployments/7/rollback": jsonResponse({ deploymentId: 8 }, 202),
      "/api/deployments/7": deployment({ status: "failed", detail: "x" }),
      "/api/deployments/8": deployment({
        id: 8,
        status: "pulling",
        oldImage: "nginx:1.28",
        newImage: "nginx:1.27",
        rollbackOf: 7,
      }),
    });
    renderPanel("admin");
    const u = user();

    await u.click(await screen.findByRole("button", { name: "Roll back" }));
    await u.click(screen.getByRole("button", { name: "Confirm roll back?" }));

    expect(await screen.findByText("nginx:1.28 → nginx:1.27")).toBeInTheDocument();
  });

  it("calls onClose from the close button", async () => {
    stubFetch({ "/api/deployments/7": deployment() });
    const onClose = renderPanel();
    const u = user();

    await u.click(await screen.findByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 8: Run tests to verify they fail**

Run (in `web/`): `npx vitest run test/DeployPanel.test.tsx`
Expected: FAIL — `DeployPanel` does not exist.

- [ ] **Step 9: Create `web/src/components/DeployPanel.tsx`**

```tsx
import { useRef, useState } from "react";
import { api, usePolling } from "../api";
import type { ContainerSummary, Deployment, Role } from "../types";

const POLL_MS = 2000;
const PHASES = ["pulling", "recreating", "watching"] as const;
const PHASE_ORDER: Record<Deployment["status"], number> = {
  pending: 0,
  pulling: 1,
  recreating: 2,
  watching: 3,
  succeeded: 4,
  failed: 4,
};

function isTerminal(d: Deployment): boolean {
  return d.status === "succeeded" || d.status === "failed";
}

/**
 * Live view of one deployment: phase progression while the pipeline runs,
 * outcome + one-click rollback when it settles. State lives server-side, so
 * a refresh resumes from the deployments table. Once the deployment is
 * terminal the fetcher short-circuits to the cached row — the interval
 * keeps ticking but no more requests go out.
 */
export function DeployPanel({
  container,
  deploymentId,
  role,
  onClose,
}: {
  container: ContainerSummary;
  deploymentId: number;
  role: Role;
  onClose: () => void;
}) {
  const [currentId, setCurrentId] = useState(deploymentId);
  const [confirmingRollback, setConfirmingRollback] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const doneRef = useRef<Deployment | null>(null);

  const polled = usePolling(async () => {
    if (doneRef.current !== null && doneRef.current.id === currentId) {
      return doneRef.current;
    }
    const d = await api.getDeployment(currentId);
    if (isTerminal(d)) doneRef.current = d;
    return d;
  }, POLL_MS);
  const dep = polled.data;

  async function fireRollback(): Promise<void> {
    setRollbackBusy(true);
    setRollbackError(null);
    try {
      const res = await api.rollbackDeployment(currentId);
      doneRef.current = null;
      setConfirmingRollback(false);
      setCurrentId(res.deploymentId);
    } catch (err) {
      setRollbackError(err instanceof Error ? err.message : "Rollback failed");
    } finally {
      setRollbackBusy(false);
    }
  }

  return (
    <aside className="deploy-panel" aria-label={`Deployment for ${container.name}`}>
      <header className="panel-head">
        <h2>
          Deploy — <span className="name">{container.name}</span>
        </h2>
        <button className="action" onClick={onClose}>
          Close
        </button>
      </header>

      {polled.error !== null && dep === null && (
        <p className="action-error" role="alert">
          {polled.error}
        </p>
      )}

      {dep !== null && (
        <>
          <p className="deploy-images">
            {dep.oldImage} → {dep.newImage}
          </p>
          <p className="deploy-meta">
            #{dep.id} · by {dep.actor}
            {dep.rollbackOf !== null ? ` · rollback of #${dep.rollbackOf}` : ""}
          </p>

          {isTerminal(dep) ? (
            <p
              className={dep.status === "succeeded" ? "deploy-ok" : "deploy-fail"}
              role="status"
            >
              {dep.status === "succeeded"
                ? "Deployment succeeded"
                : `Deployment failed — ${dep.detail ?? "no detail"}`}
            </p>
          ) : (
            <ol className="deploy-phases">
              {PHASES.map((phase, i) => {
                const idx = i + 1;
                const cls =
                  PHASE_ORDER[dep.status] > idx
                    ? "done"
                    : PHASE_ORDER[dep.status] === idx
                      ? "current"
                      : "pending";
                return (
                  <li key={phase} className={cls}>
                    {phase}
                  </li>
                );
              })}
            </ol>
          )}

          {isTerminal(dep) && role === "admin" && (
            <span className="deploy-rollback">
              <button
                className={confirmingRollback ? "action confirm" : "action"}
                disabled={rollbackBusy}
                onClick={() =>
                  confirmingRollback ? void fireRollback() : setConfirmingRollback(true)
                }
              >
                {rollbackBusy
                  ? "…"
                  : confirmingRollback
                    ? "Confirm roll back?"
                    : "Roll back"}
              </button>
              {rollbackError !== null && (
                <span className="action-error">{rollbackError}</span>
              )}
            </span>
          )}
        </>
      )}
    </aside>
  );
}
```

- [ ] **Step 10: Wire the panel into `App.tsx` and bump the footer**

In the `Console` component, add state next to `selected`:

```tsx
  const [deploy, setDeploy] = useState<{
    container: ContainerSummary;
    deploymentId: number;
  } | null>(null);
```

Update the `FleetTable` usage:

```tsx
              <FleetTable
                containers={containers.data ?? []}
                role={user.role}
                onSelect={setSelected}
                onDeployStarted={(container, deploymentId) => {
                  setSelected(null);
                  setDeploy({ container, deploymentId });
                }}
              />
```

After the `{selected && (<LogPanel …/>)}` block, add:

```tsx
          {deploy && (
            <DeployPanel
              key={deploy.deploymentId}
              container={deploy.container}
              deploymentId={deploy.deploymentId}
              role={user.role}
              onClose={() => setDeploy(null)}
            />
          )}
```

Add the import: `import { DeployPanel } from "./components/DeployPanel";`

Also clear the deploy panel when switching to the audit tab (the existing tab button already clears `selected`):

```tsx
            onClick={() => {
              setView("audit");
              setSelected(null);
              setDeploy(null);
            }}
```

Footer: change `fleet-console v0.3` to `fleet-console v0.4`.

- [ ] **Step 11: Add styles**

Append to `web/src/styles.css`:

```css
/* --- Deploy panel (Phase 3) ------------------------------------------ */

.deploy-form {
  display: inline-flex;
  gap: 0.35rem;
  align-items: center;
}

.deploy-tag {
  width: 7rem;
  font: inherit;
  padding: 0.15rem 0.4rem;
}

.deploy-panel {
  border-top: 1px solid var(--border, #444);
  padding: 0.75rem 1rem;
}

.deploy-images {
  font-family: monospace;
}

.deploy-meta {
  opacity: 0.7;
  font-size: 0.85em;
}

.deploy-phases {
  display: flex;
  gap: 1rem;
  list-style: none;
  padding: 0;
}

.deploy-phases .done {
  opacity: 0.6;
  text-decoration: line-through;
}

.deploy-phases .current {
  font-weight: 600;
}

.deploy-phases .pending {
  opacity: 0.4;
}

.deploy-ok {
  color: var(--ok, #3fb950);
}

.deploy-fail {
  color: var(--down, #f85149);
}
```

(If `styles.css` uses different variable names for its status colors, reuse whatever `.ok` / `.down` use — check the top of the file.)

- [ ] **Step 12: Run the full web suite, typecheck, build**

Run (in `web/`): `npm test`, `npm run typecheck`, `npm run build`
Expected: all pass — including the pre-existing suites.

- [ ] **Step 13: Commit**

```bash
git add web/src/api.ts web/src/components/RowActions.tsx web/src/components/FleetTable.tsx web/src/components/DeployPanel.tsx web/src/App.tsx web/src/styles.css web/test/RowActionsDeploy.test.tsx web/test/DeployPanel.test.tsx web/test/FleetTable.test.tsx
git commit -m "feat: deploy button, tag form, and DeployPanel with rollback"
```

---

### Task 7: Documentation — README, CLAUDE.md

**Files:**
- Modify: `README.md` (status line, endpoints table, roadmap, security notes)
- Modify: `CLAUDE.md` (seam rule, deployment route pattern)

**Interfaces:** none — prose only.

- [ ] **Step 1: README updates**

1. Status line (line 7) →

```markdown
> **Status: Phase 3 (deployment workflow: deploy an image tag, watch health, one-click rollback).** See [Roadmap](#roadmap).
```

2. Endpoints table — append after the restart row:

```markdown
| `POST /api/containers/:id/deploy` | session + admin | Deploy a new image tag (async — returns `202 { deploymentId }`) |
| `POST /api/deployments/:id/rollback` | session + admin | Roll back to that deployment's previous image |
| `GET /api/deployments/:id` | session | One deployment's status |
| `GET /api/deployments?container=` | session | Deployment history for a container name |
```

3. Roadmap — replace the Phase 3 line with:

```markdown
- [x] **Phase 3 — deployment workflow:** pick an image tag, deploy per container with health watch and one-click rollback; deploys admin-only, audited fail-closed
- [ ] **Phase 3.5 — CI/CD:** GitHub Actions build → push image → deploy against the console
```

4. Security notes — append after the existing mitigations paragraph:

```markdown
Deploys raise the stakes again: they change what code runs, so they require
the **admin** role (operators keep start/stop/restart) and follow the same
fail-closed audit pattern with the outcome settled when the pipeline
finishes. Three sharp edges are documented rather than solved: recreating a
compose-managed container makes `docker compose` see it as drifted (the next
`up` may recreate it); deploying fleet-console's own containers can kill the
console mid-deploy (same no-self-guard policy as Phase 2); and data in
anonymous volumes not listed in `HostConfig.Binds` does not survive the
recreate — use named volumes for anything you care about.
```

- [ ] **Step 2: CLAUDE.md updates**

1. In the server bullet under Layout, replace the audit seam sentence:

```markdown
Same pattern: `src/db.ts` is the only module that touches better-sqlite3 (connection + `user_version` migrations — append-only, never edit a shipped entry); `src/audit.ts` and `src/deployments.ts` own their tables through it. `src/auth.ts` is the only one that reads user config / verifies passwords.
```

2. In Gotchas, extend the mutating-routes bullet:

```markdown
- Mutating routes live in `server/src/routes/actions.ts` and `server/src/routes/deployments.ts`: role-gate with `requireRole` (`operator` for actions, `admin` for deploy/rollback) and audit **fail-closed** via insert-then-update — copy that pattern for any new mutating endpoint. Deploys are async: the audit row settles when the pipeline finishes, not when the 202 goes out; deployment history and the single-flight guard key on container *name* (stable across recreates), not id.
```

- [ ] **Step 3: Verify and commit**

Run (in `server/` and `web/`): `npm run typecheck` (docs-only change — quick sanity that nothing else slipped in via `git status`).

```bash
git add README.md CLAUDE.md
git commit -m "docs: Phase 3 deployment workflow — README and CLAUDE.md"
```

---

## Final verification (after all tasks)

- [ ] `npm test` + `npm run typecheck` + `npm run build` in both `server/` and `web/` — all green.
- [ ] `git status` — clean tree, no lockfile changes (`git diff --stat main -- '**/package-lock.json'` is empty; no new dependencies were added).
- [ ] Types mirror check: run the sync-types skill (or diff the two `types.ts` files) — no drift.
- [ ] Push the branch, open a PR, wait for CI.
- [ ] **Post-merge smoke test** (real daemon, like Phase 2's): `docker compose up --build`, log in as an admin, deploy `demo-nginx` to another tag (e.g. `1.27-alpine`), watch the panel walk pulling → recreating → watching → succeeded, confirm the container runs the new tag, roll back, verify the audit rows for `container.deploy` / `container.rollback`, tear down.
