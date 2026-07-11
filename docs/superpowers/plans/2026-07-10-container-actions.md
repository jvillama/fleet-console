# Container Actions (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start, stop, and restart containers from the dashboard — operator/admin only, every attempt audited fail-closed, inline confirm for the disruptive actions.

**Architecture:** Three explicit `POST /api/containers/:id/start|stop|restart` routes share one registration helper that chains id validation → role gate → fail-closed audit (insert-then-update, one row per action) → docker call. The docker seam (`docker.ts`) gains three thin wrappers that treat Docker's 304 "already in that state" as a successful no-op. The web `FleetTable` grows a role-gated actions column with a two-click inline confirm for stop/restart.

**Tech Stack:** Fastify 5 + dockerode + better-sqlite3 (server), React 18 + Vite (web), Vitest in both packages.

**Spec:** `docs/superpowers/specs/2026-07-10-container-actions-design.md`

## Global Constraints

- Server uses NodeNext resolution: relative imports must end in `.js` (e.g. `./docker.js`) even though sources are `.ts`. Web uses bundler resolution: extensionless imports.
- `server/src/types.ts` and `web/src/types.ts` are hand-mirrored — any change to one must be copied verbatim to the other.
- `server/src/docker.ts` stays the ONLY module importing dockerode; `server/src/audit.ts` the only one touching better-sqlite3.
- Existing fail-open audit callers (auth routes, log streaming) must NOT be changed to fail closed. Only the new action routes fail closed.
- Per-container failures degrade per-row in the UI — no global error banners for action failures.
- Web: plain hooks, no router, no state library, no CSS framework, no new dependencies. Web tests stub `fetch` at the boundary via `web/test/helpers.ts` (`stubFetch`) — never module-mock `../src/api`.
- No dependency changes anywhere in this plan → `package-lock.json` files must not change. If you somehow need a dependency, STOP and re-read CLAUDE.md's npm-10 lockfile gotcha first.
- Run npm commands inside `server/` or `web/`, never at the repo root.
- All commands below are written for Git Bash / POSIX sh.

---

### Task 1: Branch + shared contract types

**Files:**
- Modify: `server/src/types.ts`
- Modify: `web/src/types.ts`

**Interfaces:**
- Consumes: existing `ContainerState` in both types files.
- Produces: `ContainerAction` ("start" | "stop" | "restart") and `ContainerActionResult { id, action, state }` — identical in both files. Every later task references these exact names.

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b container-actions
```

- [ ] **Step 2: Add the types to `server/src/types.ts`**

Append inside the `// --- Auth + audit` region's end (bottom of file):

```ts
// --- Container actions (Phase 2, mirrored in web/src/types.ts) ---------

export type ContainerAction = "start" | "stop" | "restart";

export interface ContainerActionResult {
  id: string;
  action: ContainerAction;
  /** Container state after the action, from a post-action inspect. */
  state: ContainerState;
}
```

- [ ] **Step 3: Mirror the exact same block at the bottom of `web/src/types.ts`**

Same code, copied verbatim.

- [ ] **Step 4: Typecheck both packages**

```bash
cd server && npm run typecheck && cd ../web && npm run typecheck
```
Expected: both pass (types are additive).

- [ ] **Step 5: Commit**

```bash
git add server/src/types.ts web/src/types.ts
git commit -m "feat: add ContainerAction contract types (server + web mirror)"
```

---

### Task 2: Audit store — rowid return + updateEventOutcome

**Files:**
- Modify: `server/src/audit.ts`
- Test: `server/test/audit.test.ts`

**Interfaces:**
- Consumes: existing `recordEvent(event: NewAuditEvent)`, `queryEvents`, `initAudit`, `closeAudit`.
- Produces: `recordEvent(event: NewAuditEvent): number` (returns the inserted rowid) and `updateEventOutcome(id: number, outcome: "success" | "failure", detail?: string): void` (throws `Error(/not found/)` for a missing id; `detail` omitted ⇒ stored as NULL). Task 4 relies on both.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/audit.test.ts` (add `updateEventOutcome` to the existing import from `../src/audit.js`):

```ts
describe("recordEvent return value / updateEventOutcome", () => {
  it("recordEvent returns the inserted row id", () => {
    const first = recordEvent({
      actor: "alice", role: "admin", action: "container.stop",
      outcome: "failure", detail: "incomplete", target: "abc123",
    });
    const second = recordEvent({
      actor: "alice", role: "admin", action: "container.stop",
      outcome: "failure", detail: "incomplete", target: "abc123",
    });

    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  it("rewrites outcome and clears detail when none is given", () => {
    const id = recordEvent({
      actor: "alice", role: "admin", action: "container.stop",
      outcome: "failure", detail: "incomplete", target: "abc123",
    });

    updateEventOutcome(id, "success");

    const [event] = queryEvents({ limit: 1, offset: 0 }).events;
    expect(event).toMatchObject({ outcome: "success", detail: null });
  });

  it("stores the new detail when given", () => {
    const id = recordEvent({
      actor: "alice", role: "admin", action: "container.start",
      outcome: "failure", detail: "incomplete", target: "abc123",
    });

    updateEventOutcome(id, "success", "no-op: already in desired state");

    const [event] = queryEvents({ limit: 1, offset: 0 }).events;
    expect(event).toMatchObject({
      outcome: "success",
      detail: "no-op: already in desired state",
    });
  });

  it("throws for a missing row id", () => {
    expect(() => updateEventOutcome(999, "success")).toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd server && npx vitest run test/audit.test.ts
```
Expected: FAIL — `updateEventOutcome` is not exported; the rowid test fails because `recordEvent` returns undefined.

- [ ] **Step 3: Implement in `server/src/audit.ts`**

Change `recordEvent` to return the rowid and add `updateEventOutcome`:

```ts
export function recordEvent(event: NewAuditEvent): number {
  const result = requireDb()
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
  const result = requireDb()
    .prepare(`UPDATE audit_events SET outcome = ?, detail = ? WHERE id = ?`)
    .run(outcome, detail ?? null, id);
  if (result.changes === 0) {
    throw new Error(`audit event ${id} not found`);
  }
}
```

- [ ] **Step 4: Run the audit tests — all pass, then the whole server suite**

```bash
cd server && npx vitest run test/audit.test.ts && npm test
```
Expected: PASS (existing callers ignore the new return value).

- [ ] **Step 5: Commit**

```bash
git add server/src/audit.ts server/test/audit.test.ts
git commit -m "feat: audit rowid return and updateEventOutcome for fail-closed writes"
```

---

### Task 3: Docker seam — start/stop/restart wrappers

**Files:**
- Modify: `server/src/docker.ts`
- Test: `server/test/docker.test.ts`

**Interfaces:**
- Consumes: the module-level `docker` client and `toState()` already in `docker.ts`; `ContainerState` from `./types.js`.
- Produces: `ActionOutcome { state: ContainerState; noOp: boolean }` (exported interface, server-internal — NOT mirrored to web) and `startContainer(id) / stopContainer(id) / restartContainer(id): Promise<ActionOutcome>`. Task 4 calls these.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/docker.test.ts` (add `restartContainer, startContainer, stopContainer` to the existing import from `../src/docker.js`):

```ts
describe("container actions", () => {
  function mockActionContainer(overrides: Record<string, unknown> = {}) {
    const container = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({ State: { Status: "running" } }),
      ...overrides,
    };
    mockClient.getContainer.mockReturnValue(container);
    return container;
  }

  it("startContainer starts and returns the post-action state", async () => {
    const container = mockActionContainer();

    const outcome = await startContainer("abc123");

    expect(mockClient.getContainer).toHaveBeenCalledWith("abc123");
    expect(container.start).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ state: "running", noOp: false });
  });

  it("stopContainer stops and returns the post-action state", async () => {
    const container = mockActionContainer({
      inspect: vi.fn().mockResolvedValue({ State: { Status: "exited" } }),
    });

    const outcome = await stopContainer("abc123");

    expect(container.stop).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ state: "exited", noOp: false });
  });

  it("restartContainer restarts and returns the post-action state", async () => {
    const container = mockActionContainer();

    const outcome = await restartContainer("abc123");

    expect(container.restart).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ state: "running", noOp: false });
  });

  it("treats Docker's 304 (already in desired state) as a successful no-op", async () => {
    mockActionContainer({
      start: vi.fn().mockRejectedValue(
        Object.assign(new Error("container already started"), { statusCode: 304 }),
      ),
    });

    const outcome = await startContainer("abc123");

    expect(outcome).toEqual({ state: "running", noOp: true });
  });

  it("propagates non-304 errors without inspecting", async () => {
    const container = mockActionContainer({
      stop: vi.fn().mockRejectedValue(
        Object.assign(new Error("no such container"), { statusCode: 404 }),
      ),
    });

    await expect(stopContainer("deadbeef")).rejects.toThrow("no such container");
    expect(container.inspect).not.toHaveBeenCalled();
  });

  it("maps an unknown inspect status to dead", async () => {
    mockActionContainer({
      inspect: vi.fn().mockResolvedValue({ State: { Status: "glitched" } }),
    });

    const outcome = await startContainer("abc123");

    expect(outcome.state).toBe("dead");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd server && npx vitest run test/docker.test.ts
```
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement in `server/src/docker.ts`**

Add after `getFleetOverview` (before `pingDocker`):

```ts
export interface ActionOutcome {
  /** Container state after the action, from a fresh inspect. */
  state: ContainerState;
  /** True when Docker answered 304 — it was already in the desired state. */
  noOp: boolean;
}

/**
 * Shared body for the three mutating actions. Docker answers HTTP 304
 * ("not modified") when the container is already in the desired state —
 * the desired state holds, so that is success, flagged as a no-op for the
 * audit detail. Any other error propagates to the route's error mapping.
 */
async function runAction(
  id: string,
  act: (container: Docker.Container) => Promise<unknown>,
): Promise<ActionOutcome> {
  const container = docker.getContainer(id);
  let noOp = false;
  try {
    await act(container);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 304) noOp = true;
    else throw err;
  }
  const info = await container.inspect();
  return { state: toState(info.State.Status), noOp };
}

export function startContainer(id: string): Promise<ActionOutcome> {
  return runAction(id, (c) => c.start());
}

export function stopContainer(id: string): Promise<ActionOutcome> {
  // Docker's default 10s SIGTERM grace period — no timeout knob this slice.
  return runAction(id, (c) => c.stop());
}

export function restartContainer(id: string): Promise<ActionOutcome> {
  return runAction(id, (c) => c.restart());
}
```

Note: `ContainerState` is already imported in this file's type-import block.

- [ ] **Step 4: Run tests + typecheck**

```bash
cd server && npx vitest run test/docker.test.ts && npm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/docker.ts server/test/docker.test.ts
git commit -m "feat: start/stop/restart wrappers in the docker seam, 304 as no-op"
```

---

### Task 4: Role gate + action routes, registered and fully tested

**Files:**
- Create: `server/src/authz.ts`
- Create: `server/src/routes/actions.ts`
- Modify: `server/src/app.ts` (register the new routes)
- Modify: `server/test/setup.ts` (add an operator user)
- Modify: `server/test/routes.test.ts:4-10` and `server/test/logs-routes.test.ts:5-11` (extend the `vi.mock("../src/docker.js")` factories with the three new functions — vitest ESM mocks must define every export the app imports, or `buildApp()` fails to load)
- Test: `server/test/actions-routes.test.ts` (new)

**Interfaces:**
- Consumes: `recordEvent` / `updateEventOutcome` (Task 2), `startContainer` / `stopContainer` / `restartContainer` / `ActionOutcome` (Task 3), `ContainerAction` / `ContainerActionResult` (Task 1), `auditFailOpen` exported by `server/src/routes/auth.ts`.
- Produces: `requireRole(min: Role, audit: { action: string })` preHandler in `authz.ts`; `actionRoutes(app: FastifyInstance)` registering the three POSTs. The web (Task 5/6) relies on these response contracts: `200 ContainerActionResult`, `400 {error:"Invalid container id"}`, `401 {error:"Unauthorized"}`, `403 {error:"Forbidden"}`, `404 {error:"Container not found"}`, `502 {error:"Action failed"}`, `503 {error:"Audit log unavailable"}`.

- [ ] **Step 1: Add an operator to the test users in `server/test/setup.ts`**

```ts
process.env.FLEET_USERS = JSON.stringify([
  { username: "alice", role: "admin", passwordHash: hashPassword("correct horse") },
  { username: "bob", role: "viewer", passwordHash: hashPassword("battery staple") },
  { username: "carol", role: "operator", passwordHash: hashPassword("staple correct") },
]);
```

- [ ] **Step 2: Extend the docker mock factories in the two existing route test files**

In both `server/test/routes.test.ts` and `server/test/logs-routes.test.ts`, the factory becomes:

```ts
vi.mock("../src/docker.js", () => ({
  getContainerStats: vi.fn(),
  getFleetOverview: vi.fn(),
  listContainers: vi.fn(),
  pingDocker: vi.fn(),
  streamContainerLogs: vi.fn(),
  startContainer: vi.fn(),
  stopContainer: vi.fn(),
  restartContainer: vi.fn(),
}));
```

- [ ] **Step 3: Write the failing route tests**

Create `server/test/actions-routes.test.ts`:

```ts
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
}));

import * as dockerApi from "../src/docker.js";
import { buildApp } from "../src/app.js";
import { closeAudit, queryEvents } from "../src/audit.js";
import { loginAs } from "./helpers.js";

const mocked = vi.mocked(dockerApi);

let app: FastifyInstance;
let cookies: { session: string };

beforeEach(async () => {
  vi.resetAllMocks();
  app = await buildApp();
  cookies = await loginAs(app, "carol", "staple correct"); // operator
});

afterEach(async () => {
  await app.close();
});

function post(url: string, sessionCookies: { session: string } = cookies) {
  return app.inject({ method: "POST", url, cookies: sessionCookies });
}

function auditRows(action: string) {
  return queryEvents({ limit: 10, offset: 0, action }).events;
}

describe.each([
  ["start", () => mocked.startContainer, "running"],
  ["stop", () => mocked.stopContainer, "exited"],
  ["restart", () => mocked.restartContainer, "running"],
] as const)("POST /api/containers/:id/%s", (action, getMock, endState) => {
  it("runs the action and audits success with actor, target, and ip", async () => {
    getMock().mockResolvedValue({ state: endState, noOp: false });

    const res = await post(`/api/containers/abc123/${action}`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "abc123", action, state: endState });
    expect(getMock()).toHaveBeenCalledWith("abc123");
    const [row] = auditRows(`container.${action}`);
    expect(row).toMatchObject({
      actor: "carol",
      role: "operator",
      target: "abc123",
      outcome: "success",
      detail: null,
      ip: expect.any(String),
    });
  });
});

describe("guards (stop as representative)", () => {
  it("rejects without a session — no docker call, no audit row", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/containers/abc123/stop",
    });

    expect(res.statusCode).toBe(401);
    expect(mocked.stopContainer).not.toHaveBeenCalled();
    expect(auditRows("container.stop")).toHaveLength(0);
  });

  it("rejects viewers with 403 and audits the denial", async () => {
    const viewer = await loginAs(app, "bob", "battery staple");

    const res = await post("/api/containers/abc123/stop", viewer);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Forbidden" });
    expect(mocked.stopContainer).not.toHaveBeenCalled();
    const [row] = auditRows("container.stop");
    expect(row).toMatchObject({
      actor: "bob",
      role: "viewer",
      target: "abc123",
      outcome: "failure",
      detail: "forbidden",
    });
  });

  it("lets admins act", async () => {
    mocked.stopContainer.mockResolvedValue({ state: "exited", noOp: false });
    const admin = await loginAs(app, "alice", "correct horse");

    const res = await post("/api/containers/abc123/stop", admin);

    expect(res.statusCode).toBe(200);
  });

  it("rejects invalid ids before any audit write or docker call", async () => {
    const res = await post("/api/containers/bad$id/stop");

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid container id" });
    expect(mocked.stopContainer).not.toHaveBeenCalled();
    expect(auditRows("container.stop")).toHaveLength(0);
  });
});

describe("outcomes", () => {
  it("maps Docker 404s to 404 and settles the audit row as failure", async () => {
    mocked.stopContainer.mockRejectedValue(
      Object.assign(new Error("no such container"), { statusCode: 404 }),
    );

    const res = await post("/api/containers/deadbeef/stop");

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: "Container not found",
      detail: "no such container",
    });
    expect(auditRows("container.stop")[0]).toMatchObject({
      outcome: "failure",
      detail: "no such container",
    });
  });

  it("maps daemon failures to 502 and settles the audit row as failure", async () => {
    mocked.restartContainer.mockRejectedValue(new Error("socket hang up"));

    const res = await post("/api/containers/abc123/restart");

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "Action failed", detail: "socket hang up" });
    expect(auditRows("container.restart")[0]).toMatchObject({
      outcome: "failure",
      detail: "socket hang up",
    });
  });

  it("notes 304 no-ops in the audit detail", async () => {
    mocked.startContainer.mockResolvedValue({ state: "running", noOp: true });

    const res = await post("/api/containers/abc123/start");

    expect(res.statusCode).toBe(200);
    expect(auditRows("container.start")[0]).toMatchObject({
      outcome: "success",
      detail: "no-op: already in desired state",
    });
  });

  it("fails closed: 503 when the audit write fails, docker never called", async () => {
    // Login above already succeeded (auth audits fail-open). Closing the
    // store makes the action route's recordEvent throw.
    closeAudit();

    const res = await post("/api/containers/abc123/stop");

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "Audit log unavailable" });
    expect(mocked.stopContainer).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run to verify they fail**

```bash
cd server && npx vitest run test/actions-routes.test.ts
```
Expected: FAIL — all action routes 404 (routes don't exist yet).

- [ ] **Step 5: Create `server/src/authz.ts`**

```ts
import type { FastifyReply, FastifyRequest } from "fastify";
import { auditFailOpen } from "./routes/auth.js";
import type { ApiError, Role } from "./types.js";

/**
 * Role gate for routes that need more than a valid session. The global
 * onRequest gate in app.ts has already rejected anonymous/expired sessions,
 * so a missing user here is a bug — treated as forbidden, not a crash.
 */

const ROLE_ORDER: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export function requireRole(min: Role, audit: { action: string }) {
  return async function roleGate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const user = request.session.get("user");
    if (user && ROLE_ORDER[user.role] >= ROLE_ORDER[min]) return;

    // A viewer probing mutation endpoints is exactly what an audit log is
    // for. Fail-open: the action was refused anyway, nothing to close.
    auditFailOpen(request, {
      actor: user?.username ?? "unknown",
      role: user?.role ?? null,
      action: audit.action,
      target: (request.params as { id?: string }).id,
      outcome: "failure",
      detail: "forbidden",
      ip: request.ip,
    });
    const body: ApiError = { error: "Forbidden" };
    return reply.code(403).send(body);
  };
}
```

- [ ] **Step 6: Create `server/src/routes/actions.ts`**

```ts
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  restartContainer,
  startContainer,
  stopContainer,
  type ActionOutcome,
} from "../docker.js";
import { recordEvent, updateEventOutcome } from "../audit.js";
import { requireRole } from "../authz.js";
import type {
  ApiError,
  ContainerAction,
  ContainerActionResult,
} from "../types.js";

/**
 * Phase 2 mutating routes. Unlike the observe-only routes these audit
 * FAIL-CLOSED: the event row is inserted (as a provisional failure) before
 * dockerode is touched, and the action is refused with 503 if that insert
 * fails. The row is settled to the real outcome afterwards.
 */

// Container ids are hex; names are alphanumeric with ._- (same as stats).
const ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

type ActionRequest = FastifyRequest<{ Params: { id: string } }>;

async function validateId(
  request: ActionRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!ID_PATTERN.test(request.params.id)) {
    const body: ApiError = { error: "Invalid container id" };
    return reply.code(400).send(body);
  }
}

function settleAudit(
  request: ActionRequest,
  auditId: number,
  outcome: "success" | "failure",
  detail?: string,
): void {
  try {
    updateEventOutcome(auditId, outcome, detail);
  } catch (err) {
    // The action already ran — nothing to undo. The row conservatively
    // stays a provisional failure; log the discrepancy loudly.
    request.log.error({ err, auditId }, "audit outcome update failed");
  }
}

function registerAction(
  app: FastifyInstance,
  action: ContainerAction,
  run: (id: string) => Promise<ActionOutcome>,
): void {
  app.post<{ Params: { id: string } }>(
    `/api/containers/:id/${action}`,
    {
      preHandler: [
        validateId,
        requireRole("operator", { action: `container.${action}` }),
      ],
    },
    async (request, reply) => {
      const { id } = request.params;
      // The global gate + requireRole guarantee a user by now.
      const user = request.session.get("user")!;

      let auditId: number;
      try {
        auditId = recordEvent({
          actor: user.username,
          role: user.role,
          action: `container.${action}`,
          target: id,
          outcome: "failure",
          detail: "incomplete",
          ip: request.ip,
        });
      } catch (err) {
        request.log.error({ err }, "audit write failed — refusing action");
        const body: ApiError = { error: "Audit log unavailable" };
        return reply.code(503).send(body);
      }

      try {
        const outcome = await run(id);
        settleAudit(
          request,
          auditId,
          "success",
          outcome.noOp ? "no-op: already in desired state" : undefined,
        );
        const body: ContainerActionResult = { id, action, state: outcome.state };
        return body;
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as { statusCode: number }).statusCode
            : 500;
        const message = err instanceof Error ? err.message : "Action failed";
        settleAudit(request, auditId, "failure", message);
        const body: ApiError = {
          error: statusCode === 404 ? "Container not found" : "Action failed",
          detail: message,
        };
        return reply.code(statusCode === 404 ? 404 : 502).send(body);
      }
    },
  );
}

export async function actionRoutes(app: FastifyInstance): Promise<void> {
  registerAction(app, "start", startContainer);
  registerAction(app, "stop", stopContainer);
  registerAction(app, "restart", restartContainer);
}
```

- [ ] **Step 7: Register in `server/src/app.ts`**

Add the import next to the other route imports:

```ts
import { actionRoutes } from "./routes/actions.js";
```

and register after `containerRoutes`:

```ts
  await app.register(authRoutes);
  await app.register(auditRoutes);
  await app.register(containerRoutes);
  await app.register(actionRoutes);
  await app.register(logsRoutes);
```

- [ ] **Step 8: Run the new tests, then the whole server suite + typecheck**

```bash
cd server && npx vitest run test/actions-routes.test.ts && npm test && npm run typecheck
```
Expected: all PASS (typecheck includes `test/`).

- [ ] **Step 9: Commit**

```bash
git add server/src/authz.ts server/src/routes/actions.ts server/src/app.ts \
        server/test/actions-routes.test.ts server/test/setup.ts \
        server/test/routes.test.ts server/test/logs-routes.test.ts
git commit -m "feat: operator-gated start/stop/restart routes with fail-closed audit"
```

---

### Task 5: Web API helper — containerAction

**Files:**
- Modify: `web/src/api.ts`
- Test: `web/test/api.test.ts`

**Interfaces:**
- Consumes: the module-private `request<T>()` helper in `api.ts` (handles 401 → unauthorized handler, non-OK → throw); `ContainerAction` / `ContainerActionResult` from `../src/types` (Task 1).
- Produces: `api.containerAction(id: string, action: ContainerAction): Promise<ContainerActionResult>`. Task 6 calls it.

- [ ] **Step 1: Write the failing test**

Add a new `describe` block at the bottom of `web/test/api.test.ts` (the file already imports `api`, `stubFetch`, and `jsonResponse` — no import changes needed):

```ts
describe("containerAction", () => {
  it("POSTs to the action route and returns the result", async () => {
    const result = { id: "abc123", action: "stop", state: "exited" };
    const { calls } = stubFetch({ "/api/containers/abc123/stop": result });

    await expect(api.containerAction("abc123", "stop")).resolves.toEqual(result);

    expect(calls[0]?.url).toBe("/api/containers/abc123/stop");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("rejects with the HTTP status on failure", async () => {
    stubFetch({
      "/api/containers/abc123/start": jsonResponse({ error: "Action failed" }, 502),
    });

    await expect(api.containerAction("abc123", "start")).rejects.toThrow("502");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd web && npx vitest run test/api.test.ts
```
Expected: FAIL — `api.containerAction` is not a function.

- [ ] **Step 3: Implement in `web/src/api.ts`**

Add `ContainerAction` and `ContainerActionResult` to the type import from `./types`, then add to the `api` object after `stats`:

```ts
  containerAction: (id: string, action: ContainerAction) =>
    request<ContainerActionResult>(`/api/containers/${id}/${action}`, {
      method: "POST",
    }),
```

- [ ] **Step 4: Run tests + typecheck**

```bash
cd web && npx vitest run test/api.test.ts && npm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/test/api.test.ts
git commit -m "feat: containerAction API helper"
```

---

### Task 6: Web UI — RowActions, role-gated FleetTable column, App wiring

**Files:**
- Create: `web/src/components/RowActions.tsx`
- Modify: `web/src/components/FleetTable.tsx`
- Modify: `web/src/App.tsx` (pass `role`, ~line 120)
- Modify: `web/src/styles.css` (action button styles)
- Test: `web/test/FleetTable.test.tsx`

**Interfaces:**
- Consumes: `api.containerAction` (Task 5); `ContainerAction`, `ContainerState`, `ContainerSummary`, `Role` from `../src/types`.
- Produces: `RowActions({ container, state, onStateChange })` component; `FleetTable` gains a REQUIRED `role: Role` prop (existing callers must be updated). `App.tsx` passes `role={user.role}`.

- [ ] **Step 1: Update existing FleetTable tests for the new required prop, and write the failing action tests**

In `web/test/FleetTable.test.tsx`, add `role="viewer"` to the four existing `render(<FleetTable ... />)` calls (keeps their behavior identical — viewers see no actions). Update the imports:

```tsx
import { act, render, screen, within } from "@testing-library/react";
```

Then append:

```tsx
describe("FleetTable actions", () => {
  const actionResult = { id: "dead1", action: "start", state: "running" };

  function stopped(overrides: Partial<ContainerSummary> = {}): ContainerSummary {
    return container({
      id: "dead1",
      shortId: "dead1short00",
      name: "worker-1",
      state: "exited",
      status: "Exited (0) 2 days ago",
      ...overrides,
    });
  }

  it("viewers see no action buttons", () => {
    render(<FleetTable containers={[stopped()]} role="viewer" onSelect={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /start|stop|restart/i })).toBeNull();
  });

  it("operators see Start on stopped rows, Stop and Restart on running rows", async () => {
    stubFetch({ "/api/containers/run1/stats": jsonResponse(statsFixture) });

    render(
      <FleetTable
        containers={[container({}), stopped()]}
        role="operator"
        onSelect={vi.fn()}
      />,
    );

    const runningRow = rowFor("web-1");
    expect(within(runningRow).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(within(runningRow).getByRole("button", { name: "Restart" })).toBeInTheDocument();
    expect(within(runningRow).queryByRole("button", { name: "Start" })).toBeNull();

    const stoppedRow = rowFor("worker-1");
    expect(within(stoppedRow).getByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(within(stoppedRow).queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("Start fires immediately, POSTs, and updates the row state", async () => {
    const { calls } = stubFetch({ "/api/containers/dead1/start": actionResult });
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(<FleetTable containers={[stopped()]} role="admin" onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "Start" }));

    const post = calls.find((c) => c.url === "/api/containers/dead1/start");
    expect(post?.init?.method).toBe("POST");
    // Row reflects the returned state without waiting for the next poll.
    expect(await screen.findByRole("img", { name: "running" })).toBeInTheDocument();
    // The button click must not bubble into row selection (log panel).
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("Stop requires a second confirming click", async () => {
    const { calls } = stubFetch({
      "/api/containers/run1/stats": jsonResponse(statsFixture),
      "/api/containers/run1/stop": { id: "run1", action: "stop", state: "exited" },
    });
    const user = userEvent.setup();

    render(<FleetTable containers={[container({})]} role="operator" onSelect={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("button", { name: "Confirm stop?" })).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/containers/run1/stop")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Confirm stop?" }));
    expect(calls.some((c) => c.url === "/api/containers/run1/stop")).toBe(true);
    expect(await screen.findByRole("img", { name: "exited" })).toBeInTheDocument();
  });

  it("the confirm state reverts after the timeout", async () => {
    stubFetch({ "/api/containers/run1/stats": jsonResponse(statsFixture) });
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<FleetTable containers={[container({})]} role="operator" onSelect={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("button", { name: "Confirm stop?" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("a failed action shows an inline error on that row only", async () => {
    stubFetch({
      "/api/containers/dead1/start": jsonResponse({ error: "Action failed" }, 502),
    });
    const user = userEvent.setup();

    render(<FleetTable containers={[stopped()]} role="admin" onSelect={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Start" }));

    const row = rowFor("worker-1");
    expect(await within(row).findByText(/HTTP 502/)).toBeInTheDocument();
    // No global banner — the table itself stays rendered.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail (and old ones still pass)**

```bash
cd web && npx vitest run test/FleetTable.test.tsx
```
Expected: existing tests PASS (typecheck errors on `role` don't stop esbuild-transpiled Vitest runs), new tests FAIL — no buttons rendered.

- [ ] **Step 3: Create `web/src/components/RowActions.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ContainerAction, ContainerState, ContainerSummary } from "../types";

const CONFIRM_MS = 4000;

const LABELS: Record<ContainerAction, string> = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
};

/** Stop/restart interrupt a running workload — make the user click twice. */
const NEEDS_CONFIRM: readonly ContainerAction[] = ["stop", "restart"];

function availableActions(state: ContainerState): ContainerAction[] {
  if (state === "running" || state === "restarting") return ["stop", "restart"];
  if (state === "exited" || state === "created" || state === "dead") return ["start"];
  return []; // paused / removing: out of scope this slice
}

/**
 * Action buttons for one fleet row. Owns its own confirm/busy/error state;
 * reports the post-action container state up so the table can reflect it
 * before the next poll.
 */
export function RowActions({
  container,
  state,
  onStateChange,
}: {
  container: ContainerSummary;
  /** Effective state — the table may already be showing a post-action override. */
  state: ContainerState;
  onStateChange: (id: string, state: ContainerState) => void;
}) {
  const [confirming, setConfirming] = useState<ContainerAction | null>(null);
  const [busy, setBusy] = useState<ContainerAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function fire(action: ContainerAction): Promise<void> {
    setBusy(action);
    setError(null);
    try {
      const result = await api.containerAction(container.id, action);
      onStateChange(container.id, result.state);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  function handleClick(e: React.MouseEvent, action: ContainerAction): void {
    e.stopPropagation(); // the row click opens the log panel
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (NEEDS_CONFIRM.includes(action) && confirming !== action) {
      setConfirming(action);
      setError(null);
      timer.current = window.setTimeout(() => setConfirming(null), CONFIRM_MS);
      return;
    }
    setConfirming(null);
    void fire(action);
  }

  const actions = availableActions(state);
  if (actions.length === 0 && error === null) return null;

  return (
    <span className="row-actions">
      {actions.map((action) => (
        <button
          key={action}
          className={confirming === action ? "action confirm" : "action"}
          disabled={busy !== null}
          onClick={(e) => handleClick(e, action)}
        >
          {busy === action
            ? "…"
            : confirming === action
              ? `Confirm ${action}?`
              : LABELS[action]}
        </button>
      ))}
      {error !== null && <span className="action-error">{error}</span>}
    </span>
  );
}
```

- [ ] **Step 4: Wire it into `web/src/components/FleetTable.tsx`**

Update imports and the component:

```tsx
import { useEffect, useState } from "react";
import { api, formatBytes } from "../api";
import type { ContainerState, ContainerStats, ContainerSummary, Role } from "../types";
import { RowActions } from "./RowActions";
import { StatusLed } from "./StatusLed";
```

Signature and body changes (only the parts that change are shown — keep `useFleetStats`, `formatPorts`, and the empty state exactly as they are):

```tsx
export function FleetTable({
  containers,
  role,
  onSelect,
}: {
  containers: ContainerSummary[];
  role: Role;
  onSelect: (container: ContainerSummary) => void;
}) {
  const stats = useFleetStats(containers);
  // Post-action states shown until the next poll delivers fresh truth.
  const [stateOverrides, setStateOverrides] = useState<Record<string, ContainerState>>({});

  useEffect(() => setStateOverrides({}), [containers]);

  const canAct = role !== "viewer";
```

In the `<thead>` row, append after the Memory header:

```tsx
          {canAct && <th aria-label="actions" />}
```

In the body row, compute the effective state and use it for the LED and the down-styling; append the actions cell after Memory:

```tsx
        {containers.map((c) => {
          const s = stats[c.id];
          const state = stateOverrides[c.id] ?? c.state;
          return (
            <tr
              key={c.id}
              className={state !== "running" ? "row-down" : ""}
              onClick={() => onSelect(c)}
            >
              <td>
                <StatusLed state={state} />
              </td>
```

(name/image/status/ports/CPU/memory cells unchanged), then before `</tr>`:

```tsx
              {canAct && (
                <td className="actions-cell">
                  <RowActions
                    container={c}
                    state={state}
                    onStateChange={(id, next) =>
                      setStateOverrides((prev) => ({ ...prev, [id]: next }))
                    }
                  />
                </td>
              )}
```

- [ ] **Step 5: Pass the role from `web/src/App.tsx`**

At the `FleetTable` call site (~line 120):

```tsx
              <FleetTable
                containers={containers.data ?? []}
                role={user.role}
                onSelect={setSelected}
              />
```

- [ ] **Step 6: Add styles to `web/src/styles.css`**

Append (palette variables already exist in `:root`):

```css
/* --- Row actions (Phase 2) ------------------------------------------ */

.actions-cell {
  white-space: nowrap;
  text-align: right;
}

.row-actions {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.action {
  font: inherit;
  font-size: 12px;
  color: var(--text);
  background: var(--surface-raised);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 2px 10px;
  cursor: pointer;
}

.action:hover:not(:disabled) {
  border-color: var(--text-dim);
}

.action:disabled {
  opacity: 0.5;
  cursor: default;
}

.action.confirm {
  color: var(--led-warn);
  border-color: var(--led-warn);
}

.action-error {
  color: var(--led-down);
  font-size: 12px;
}
```

- [ ] **Step 7: Run the web suite + typecheck + build**

```bash
cd web && npm test && npm run typecheck && npm run build
```
Expected: all PASS. If `App.test.tsx` fails on the new required prop, it means a `FleetTable` render there needs `role` — but App renders it via the real `App`, which now passes `user.role`, so no change should be needed.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/RowActions.tsx web/src/components/FleetTable.tsx \
        web/src/App.tsx web/src/styles.css web/test/FleetTable.test.tsx
git commit -m "feat: role-gated container action buttons with inline confirm"
```

---

### Task 7: Compose, docs, footer copy, final verification

**Files:**
- Modify: `docker-compose.yml:12-17` (socket mount)
- Modify: `README.md` (status line, architecture diagram label, tradeoffs table, endpoints table, roadmap, security notes)
- Modify: `CLAUDE.md` (observe-only gotcha → Phase 2 reality)
- Modify: `web/src/App.tsx:144` (footer copy)

**Interfaces:**
- Consumes: everything shipped in Tasks 1–6.
- Produces: no code interfaces — documentation and configuration must match the shipped behavior.

- [ ] **Step 1: Flip the socket mount in `docker-compose.yml`**

Replace the volumes comment + mount:

```yaml
    volumes:
      # Read-write Docker socket: Phase 2 adds start/stop/restart. This is
      # root-equivalent access to the host — which is why actions require
      # the operator/admin role and are audited fail-closed. Note the
      # console can stop its own containers (server/web) from its own UI;
      # there is deliberately no self-guard (see README security notes).
      - /var/run/docker.sock:/var/run/docker.sock
      - audit-data:/data
```

- [ ] **Step 2: Update `README.md`**

1. Status line (line 7):

```markdown
> **Status: Phase 2 (container actions: start/stop/restart, role-gated, audited fail-closed).** See [Roadmap](#roadmap).
```

2. Architecture diagram (line 29): change `▼ (read-only)` to `▼ (read-write)`.

3. Tradeoffs table (line 47): replace the read-only row with:

```markdown
| Docker socket mounted **read-write** | Phase 2 actions need it. Mitigations: session + role gate on every mutating route, fail-closed audit, nginx as sole ingress. The console can stop itself — documented, not guarded. |
```

4. Endpoints table (after the `WS /api/logs/:id` row, line 127):

```markdown
| `POST /api/containers/:id/start` | session + operator | Start a container |
| `POST /api/containers/:id/stop` | session + operator | Stop a container (10s grace) |
| `POST /api/containers/:id/restart` | session + operator | Restart a container |
```

5. Roadmap (line 134): tick the Phase 2 box:

```markdown
- [x] **Phase 2 — actions:** start/stop/restart from the UI; socket mounted `rw`; role enforcement; mutating actions audited **fail-closed**
```

6. Security notes (lines 140–146): replace the first half of the paragraph (through "…see the design spec).") with:

```markdown
Mounting the Docker socket into a container is equivalent to root on the
host. Phase 1 mounted it read-only; Phase 2 (container actions) mounts it
read-write, so the console itself is now a high-value target. Mitigations:
every mutating route requires an operator or admin session (viewers are
read-only), and every action attempt is audited **fail-closed** — if the
audit write fails, the action is refused with a 503. One deliberate
footgun: the console can stop its own containers from its own dashboard,
exactly as `docker stop` could; there is no self-protection guard, so
operators should treat the fleet-console rows with the same care as a
terminal.
```

Keep the remaining TLS / trustProxy sentences unchanged.

- [ ] **Step 3: Update `CLAUDE.md`**

Replace the gotcha bullet:

```markdown
- The compose file mounts the Docker socket read-only; Phase 1 is observe-only. Don't add mutating Docker endpoints without revisiting that mount and auth.
```

with:

```markdown
- The compose file mounts the Docker socket read-write (Phase 2). Mutating routes live in `server/src/routes/actions.ts`: role-gate with `requireRole` from `src/authz.ts` and audit **fail-closed** via insert-then-update (`recordEvent` → act → `updateEventOutcome`) — copy that pattern for any new mutating endpoint.
```

And update the audit-policy bullet:

```markdown
- Audit policy: reads and auth fail open (log + continue) when an audit write fails; mutating container actions fail closed (503, Docker untouched). Don't "fix" the fail-open behavior in auth routes.
```

- [ ] **Step 4: Update the footer copy in `web/src/App.tsx` (line 144)**

```tsx
        <span>fleet-console v0.3 · authenticated · actions audited</span>
```

(No test asserts the old copy — verified during planning.)

- [ ] **Step 5: Full verification of both packages**

```bash
cd server && npm test && npm run typecheck && npm run build && \
cd ../web && npm test && npm run typecheck && npm run build
```
Expected: everything green. Also confirm no lockfile drifted:

```bash
git status --porcelain -- '*package-lock.json'
```
Expected: empty output.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml README.md CLAUDE.md web/src/App.tsx
git commit -m "feat: rw socket mount and Phase 2 docs; footer copy"
```

- [ ] **Step 7 (optional, requires a local Docker daemon): compose smoke test**

```bash
docker compose up --build -d
# open http://localhost:8080, log in, stop + start demo-nginx as an
# operator/admin; check the audit tab shows container.stop / container.start
docker compose down
```

---

## Verification checklist (whole branch)

- `server`: `npm test` green (audit, docker, actions-routes suites included), `npm run typecheck` green.
- `web`: `npm test` green (FleetTable action tests included), `npm run typecheck` + `npm run build` green.
- `git diff main -- '*package-lock.json'` is empty.
- Viewer login (bob) sees no action buttons; operator (carol) and admin (alice) do.
- The fail-closed test proves Docker is never touched when the audit insert fails.
