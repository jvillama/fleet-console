# Auth + Audit Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Named-user login with an encrypted session cookie, a global auth gate over the API, and a SQLite-backed audit log with a viewer in the SPA — the foundation the roadmap requires before any mutating Docker endpoints.

**Architecture:** Stateless encrypted session cookie (`@fastify/secure-session`) with scrypt password hashing (Node built-in crypto); users seeded from env. A new `server/src/audit.ts` is the only module that touches `better-sqlite3`, mirroring the existing `docker.ts` seam. A global `onRequest` hook gates every `/api/*` route except `/api/health` and `/api/login`. The React SPA gains a login screen, a 401-aware fetch wrapper, and a Dashboard | Audit log view toggle (conditional render, no router).

**Tech Stack:** Fastify 5, `@fastify/secure-session`, `@fastify/rate-limit`, `better-sqlite3`, Node 22 `crypto.scrypt`, Vitest, React 18 + Vite.

**Spec:** `docs/superpowers/specs/2026-07-09-auth-audit-log-design.md`

## Global Constraints

- Two independent npm packages — run every npm command inside `server/` or `web/`, never at the repo root.
- Server is Node 22 ESM with NodeNext resolution: **relative imports must end in `.js`** (e.g. `./auth.js`) even though sources are `.ts`. Web uses bundler resolution: extensionless imports.
- Server tsconfig has `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` — never assign `undefined` to an optional property; build objects conditionally (the code below already does this; keep the pattern).
- `server/src/types.ts` and `web/src/types.ts` are hand-mirrored API contract types — any change to one must be copied verbatim to the other.
- `src/docker.ts` stays the only module touching dockerode; this plan adds `src/audit.ts` as the only module touching better-sqlite3 and `src/auth.ts` as the only module reading user config / verifying passwords.
- The Docker socket mount stays **read-only** (`:ro`). No mutating Docker endpoints in this plan.
- Audit failure policy: **fail-open in this slice** (log the error, let the request proceed). Phase 2 mutating endpoints must fail closed — do not "fix" the fail-open behavior.
- Tests must not need a Docker daemon or a real filesystem (SQLite uses `:memory:`).
- Commit messages: conventional prefix (`feat:`/`test:`/`docs:`), **no Co-Authored-By trailer**.
- The existing 23 tests must keep passing at the end of every task.

---

### Task 1: Contract types + password hashing and user store (`auth.ts`)

**Files:**
- Modify: `server/src/types.ts` (append new contract types)
- Create: `server/src/auth.ts`
- Create: `server/scripts/hash-password.ts`
- Modify: `server/tsconfig.json` (include `scripts`)
- Modify: `server/package.json` (add `hash-password` script)
- Test: `server/test/auth.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on these exact signatures):
  - Types: `Role`, `SessionUser`, `LoginRequest`, `AuditEvent`, `AuditPage` in `server/src/types.ts`
  - `hashPassword(password: string): string` — returns `scrypt:<salt-hex>:<hash-hex>`
  - `verifyPassword(password: string, stored: string): boolean`
  - `loadUsers(env?: NodeJS.ProcessEnv): UserRecord[]` where `UserRecord = { username: string; role: Role; passwordHash: string }`
  - `authenticate(username: string, password: string, users: UserRecord[]): SessionUser | null`

- [ ] **Step 1: Append contract types to `server/src/types.ts`**

Add at the end of the file:

```ts
// --- Auth + audit (mirrored in web/src/types.ts) -----------------------

export type Role = "admin" | "operator" | "viewer";

export interface SessionUser {
  username: string;
  role: Role;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuditEvent {
  id: number;
  ts: string; // ISO 8601 UTC
  actor: string;
  /** Null when the actor was unauthenticated (failed login attempt). */
  role: Role | null;
  /** Dotted verb, e.g. "auth.login", later "container.start". */
  action: string;
  /** Null for auth events; container id for Phase 2 container actions. */
  target: string | null;
  outcome: "success" | "failure";
  ip: string | null;
  detail: string | null;
}

export interface AuditPage {
  events: AuditEvent[];
  total: number;
}
```

- [ ] **Step 2: Write the failing test**

Create `server/test/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  authenticate,
  hashPassword,
  loadUsers,
  verifyPassword,
  type UserRecord,
} from "../src/auth.js";

describe("password hashing", () => {
  it("verifies a password against its own hash", () => {
    const hash = hashPassword("correct horse");
    expect(hash).toMatch(/^scrypt:[0-9a-f]+:[0-9a-f]+$/);
    expect(verifyPassword("correct horse", hash)).toBe(true);
  });

  it("rejects the wrong password", () => {
    const hash = hashPassword("correct horse");
    expect(verifyPassword("battery staple", hash)).toBe(false);
  });

  it("produces a different salt (and hash) every time", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects malformed stored hashes instead of throwing", () => {
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "plaintext")).toBe(false);
    expect(verifyPassword("x", "bcrypt:aa:bb")).toBe(false);
    expect(verifyPassword("x", "scrypt::")).toBe(false);
  });
});

describe("loadUsers", () => {
  it("parses users from FLEET_USERS JSON", () => {
    const users = loadUsers({
      FLEET_USERS: JSON.stringify([
        { username: "alice", role: "admin", passwordHash: "scrypt:aa:bb" },
      ]),
    } as NodeJS.ProcessEnv);
    expect(users).toEqual([
      { username: "alice", role: "admin", passwordHash: "scrypt:aa:bb" },
    ]);
  });

  it("returns an empty list when nothing is configured", () => {
    expect(loadUsers({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("throws on invalid JSON", () => {
    expect(() =>
      loadUsers({ FLEET_USERS: "not json" } as NodeJS.ProcessEnv),
    ).toThrow(/valid JSON/);
  });

  it("throws on entries missing fields or with unknown roles", () => {
    expect(() =>
      loadUsers({
        FLEET_USERS: JSON.stringify([{ username: "a", role: "root", passwordHash: "x" }]),
      } as NodeJS.ProcessEnv),
    ).toThrow(/entry 0/);
    expect(() =>
      loadUsers({
        FLEET_USERS: JSON.stringify([{ username: "a" }]),
      } as NodeJS.ProcessEnv),
    ).toThrow(/entry 0/);
  });
});

describe("authenticate", () => {
  const users: UserRecord[] = [
    { username: "alice", role: "admin", passwordHash: hashPassword("correct horse") },
  ];

  it("returns the session user on valid credentials", () => {
    expect(authenticate("alice", "correct horse", users)).toEqual({
      username: "alice",
      role: "admin",
    });
  });

  it("returns null for a wrong password", () => {
    expect(authenticate("alice", "wrong", users)).toBeNull();
  });

  it("returns null for an unknown username", () => {
    expect(authenticate("mallory", "correct horse", users)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run (in `server/`): `npm test -- test/auth.test.ts`
Expected: FAIL — cannot resolve `../src/auth.js`.

- [ ] **Step 4: Implement `server/src/auth.ts`**

```ts
import { readFileSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Role, SessionUser } from "./types.js";

/**
 * User store + password hashing. This is the only module that reads user
 * config (FLEET_USERS / FLEET_USERS_FILE) or verifies passwords — the same
 * "one module owns the dependency" pattern as docker.ts.
 */

export interface UserRecord {
  username: string;
  role: Role;
  passwordHash: string;
}

const ROLES: readonly string[] = ["admin", "operator", "viewer"];

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const saltHex = parts[1];
  const hashHex = parts[2];
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length === 0) return false;
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

// Verified for unknown usernames so a login attempt costs the same time
// whether or not the user exists (no username probing via timing).
const DUMMY_HASH = hashPassword("fleet-console-dummy");

export function loadUsers(env: NodeJS.ProcessEnv = process.env): UserRecord[] {
  const raw = env.FLEET_USERS_FILE
    ? readFileSync(env.FLEET_USERS_FILE, "utf8")
    : env.FLEET_USERS;
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("FLEET_USERS must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("FLEET_USERS must be a JSON array of users");
  }
  return parsed.map((entry, i) => {
    const u = entry as Partial<UserRecord>;
    if (
      typeof u.username !== "string" ||
      u.username.length === 0 ||
      typeof u.passwordHash !== "string" ||
      typeof u.role !== "string" ||
      !ROLES.includes(u.role)
    ) {
      throw new Error(
        `FLEET_USERS entry ${i} is invalid — need {username, role (admin|operator|viewer), passwordHash}`,
      );
    }
    return { username: u.username, role: u.role as Role, passwordHash: u.passwordHash };
  });
}

export function authenticate(
  username: string,
  password: string,
  users: UserRecord[],
): SessionUser | null {
  const user = users.find((u) => u.username === username);
  if (!user) {
    verifyPassword(password, DUMMY_HASH); // burn the same time as a real check
    return null;
  }
  return verifyPassword(password, user.passwordHash)
    ? { username: user.username, role: user.role }
    : null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run (in `server/`): `npm test -- test/auth.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Add the hash-password script**

Create `server/scripts/hash-password.ts`:

```ts
import { hashPassword } from "../src/auth.js";

const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run hash-password -- "<password>"');
  process.exit(1);
}
console.log(hashPassword(password));
```

In `server/package.json`, add to `"scripts"`:

```json
"hash-password": "tsx scripts/hash-password.ts",
```

In `server/tsconfig.json`, change the include line to:

```json
"include": ["src", "test", "scripts"]
```

- [ ] **Step 7: Verify script + typecheck + full suite**

Run (in `server/`):
- `npm run hash-password -- "demo"` → prints one `scrypt:<hex>:<hex>` line
- `npm run typecheck` → no errors
- `npm test` → all tests pass (23 existing + 12 new)

- [ ] **Step 8: Commit**

```bash
git add server/src/types.ts server/src/auth.ts server/scripts/hash-password.ts server/tsconfig.json server/package.json server/test/auth.test.ts
git commit -m "feat: add user store, scrypt password hashing, and auth contract types"
```

---

### Task 2: Audit storage module (`audit.ts`)

**Files:**
- Modify: `server/package.json` (deps via npm install)
- Create: `server/src/audit.ts`
- Test: `server/test/audit.test.ts`

**Interfaces:**
- Consumes: `AuditEvent`, `AuditPage`, `Role` from `./types.js` (Task 1).
- Produces (later tasks rely on these exact signatures):
  - `initAudit(path: string): void` — idempotent; closes and reopens
  - `closeAudit(): void`
  - `recordEvent(event: NewAuditEvent): void` — **throws** if init failed/closed (callers decide fail-open vs fail-closed)
  - `queryEvents(q: { limit: number; offset: number; actor?: string; action?: string }): AuditPage` — newest-first
  - `interface NewAuditEvent { actor: string; role: Role | null; action: string; outcome: "success" | "failure"; target?: string; ip?: string; detail?: string }`

- [ ] **Step 1: Install better-sqlite3**

Run (in `server/`):

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

- [ ] **Step 2: Write the failing test**

Create `server/test/audit.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeAudit,
  initAudit,
  queryEvents,
  recordEvent,
} from "../src/audit.js";

beforeEach(() => {
  initAudit(":memory:");
});

afterEach(() => {
  closeAudit();
});

function record(actor: string, action = "auth.login", outcome: "success" | "failure" = "success") {
  recordEvent({ actor, role: "admin", action, outcome, ip: "127.0.0.1" });
}

describe("recordEvent / queryEvents", () => {
  it("round-trips an event with all fields", () => {
    recordEvent({
      actor: "alice",
      role: "admin",
      action: "auth.login",
      outcome: "success",
      target: "abc123",
      ip: "10.0.0.1",
      detail: '{"note":"hi"}',
    });

    const page = queryEvents({ limit: 10, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.events[0]).toMatchObject({
      actor: "alice",
      role: "admin",
      action: "auth.login",
      outcome: "success",
      target: "abc123",
      ip: "10.0.0.1",
      detail: '{"note":"hi"}',
    });
    expect(page.events[0]?.id).toBe(1);
    expect(page.events[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("stores null for omitted optional fields and null role", () => {
    recordEvent({ actor: "mallory", role: null, action: "auth.login_failed", outcome: "failure" });

    const page = queryEvents({ limit: 10, offset: 0 });
    expect(page.events[0]).toMatchObject({
      role: null,
      target: null,
      ip: null,
      detail: null,
    });
  });

  it("returns newest first and paginates", () => {
    for (let i = 1; i <= 5; i++) record(`user${i}`);

    const first = queryEvents({ limit: 2, offset: 0 });
    expect(first.total).toBe(5);
    expect(first.events.map((e) => e.actor)).toEqual(["user5", "user4"]);

    const next = queryEvents({ limit: 2, offset: 2 });
    expect(next.events.map((e) => e.actor)).toEqual(["user3", "user2"]);
  });

  it("filters by actor and action, with filtered totals", () => {
    record("alice", "auth.login");
    record("bob", "auth.login");
    record("alice", "auth.logout");

    const byActor = queryEvents({ limit: 10, offset: 0, actor: "alice" });
    expect(byActor.total).toBe(2);
    expect(byActor.events.every((e) => e.actor === "alice")).toBe(true);

    const byBoth = queryEvents({ limit: 10, offset: 0, actor: "alice", action: "auth.logout" });
    expect(byBoth.total).toBe(1);
    expect(byBoth.events[0]?.action).toBe("auth.logout");
  });

  it("throws when the store is closed (callers own the failure policy)", () => {
    closeAudit();
    expect(() => record("alice")).toThrow(/not initialized/);
    initAudit(":memory:"); // leave a store for afterEach
  });

  it("re-initializing gives a fresh store", () => {
    record("alice");
    initAudit(":memory:");
    expect(queryEvents({ limit: 10, offset: 0 }).total).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run (in `server/`): `npm test -- test/audit.test.ts`
Expected: FAIL — cannot resolve `../src/audit.js`.

- [ ] **Step 4: Implement `server/src/audit.ts`**

```ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { AuditEvent, AuditPage, Role } from "./types.js";

/**
 * Audit log storage. This is the only module that touches better-sqlite3 —
 * the same "one module owns the dependency" pattern as docker.ts.
 *
 * recordEvent() throws on failure; callers choose the policy. In this
 * observe-only slice callers fail open (log and continue). Phase 2 mutating
 * endpoints must fail closed (refuse the action if the write fails).
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

let db: Database.Database | null = null;

export function initAudit(path: string): void {
  closeAudit();
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
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
}

export function closeAudit(): void {
  db?.close();
  db = null;
}

function requireDb(): Database.Database {
  if (!db) throw new Error("Audit store not initialized — call initAudit() first");
  return db;
}

export function recordEvent(event: NewAuditEvent): void {
  requireDb()
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

  const d = requireDb();
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run (in `server/`): `npm test -- test/audit.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck + full suite + commit**

Run (in `server/`): `npm run typecheck` then `npm test` — all green.

```bash
git add server/src/audit.ts server/test/audit.test.ts server/package.json server/package-lock.json
git commit -m "feat: add SQLite audit log module behind audit.ts seam"
```

---

### Task 3: Session plugin, login/logout/me routes, test env scaffolding

**Files:**
- Modify: `server/package.json` (dep via npm install)
- Create: `server/vitest.config.ts`
- Create: `server/test/setup.ts`
- Create: `server/test/helpers.ts`
- Create: `server/src/routes/auth.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`
- Test: `server/test/auth-routes.test.ts`

**Interfaces:**
- Consumes: `authenticate`, `loadUsers` (Task 1); `initAudit`, `closeAudit`, `recordEvent`, `NewAuditEvent` (Task 2); types (Task 1).
- Produces:
  - `authRoutes(app: FastifyInstance): Promise<void>` registering `POST /api/login`, `POST /api/logout`, `GET /api/me`
  - Session payload keys: `user: SessionUser`, `issuedAt: number` (module augmentation in `app.ts`)
  - Session cookie name: `"session"`
  - Test helper `loginAs(app, username?, password?): Promise<{ session: string }>` (pass as `cookies:` to `app.inject`)
  - Test env (from `test/setup.ts`): users `alice`/`correct horse` (admin) and `bob`/`battery staple` (viewer); `AUDIT_DB_PATH=":memory:"`
  - `buildApp()` now **throws** unless `FLEET_SESSION_SECRET` is set (≥ 32 chars)

- [ ] **Step 1: Install @fastify/secure-session**

Run (in `server/`):

```bash
npm install @fastify/secure-session
```

- [ ] **Step 2: Create test scaffolding**

Create `server/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
```

Create `server/test/setup.ts`:

```ts
import { hashPassword } from "../src/auth.js";

// Deterministic auth environment for every test file. buildApp() reads these;
// individual tests that need different values must save and restore them.
process.env.FLEET_SESSION_SECRET = "vitest-session-secret-0123456789abcdef";
process.env.AUDIT_DB_PATH = ":memory:";
process.env.FLEET_USERS = JSON.stringify([
  { username: "alice", role: "admin", passwordHash: hashPassword("correct horse") },
  { username: "bob", role: "viewer", passwordHash: hashPassword("battery staple") },
]);
delete process.env.FLEET_USERS_FILE;
delete process.env.FLEET_COOKIE_SECURE;
```

Create `server/test/helpers.ts`:

```ts
import type { FastifyInstance } from "fastify";

/** Log in via the real route and return cookies for app.inject({ cookies }). */
export async function loginAs(
  app: FastifyInstance,
  username = "alice",
  password = "correct horse",
): Promise<{ session: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { username, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`loginAs failed: HTTP ${res.statusCode} ${res.body}`);
  }
  const cookie = res.cookies.find((c) => c.name === "session");
  if (!cookie) throw new Error("loginAs: no session cookie in response");
  return { session: cookie.value };
}
```

- [ ] **Step 3: Write the failing tests**

Create `server/test/auth-routes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { closeAudit, queryEvents } from "../src/audit.js";
import { loginAs } from "./helpers.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe("POST /api/login", () => {
  it("logs in a configured user and sets the session cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "alice", password: "correct horse" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ username: "alice", role: "admin" });
    const cookie = res.cookies.find((c) => c.name === "session");
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe("strict");
  });

  it("rejects a wrong password with a generic 401 and no cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "alice", password: "wrong" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Invalid credentials" });
    expect(res.cookies.find((c) => c.name === "session")).toBeUndefined();
  });

  it("rejects an unknown user with the same generic 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "mallory", password: "whatever" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Invalid credentials" });
  });

  it("rejects a malformed body with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "alice" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/me", () => {
  it("returns the session user with a valid cookie", async () => {
    const cookies = await loginAs(app);

    const res = await app.inject({ url: "/api/me", cookies });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ username: "alice", role: "admin" });
  });

  it("returns 401 without a session", async () => {
    const res = await app.inject({ url: "/api/me" });

    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/logout", () => {
  it("clears the session cookie", async () => {
    const cookies = await loginAs(app);

    const res = await app.inject({ method: "POST", url: "/api/logout", cookies });

    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((c) => c.name === "session");
    expect(cleared).toBeDefined();
    expect(cleared?.value).toBe("");
  });
});

describe("audit trail of auth events", () => {
  it("records failed then successful logins, newest first", async () => {
    await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "alice", password: "wrong" },
    });
    await loginAs(app);

    const page = queryEvents({ limit: 10, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.events[0]).toMatchObject({
      actor: "alice",
      role: "admin",
      action: "auth.login",
      outcome: "success",
    });
    expect(page.events[1]).toMatchObject({
      actor: "alice",
      role: null,
      action: "auth.login_failed",
      outcome: "failure",
    });
    expect(page.events[0]?.ip).toBeTruthy();
  });

  it("records logout", async () => {
    const cookies = await loginAs(app);
    await app.inject({ method: "POST", url: "/api/logout", cookies });

    const page = queryEvents({ limit: 10, offset: 0, action: "auth.logout" });
    expect(page.total).toBe(1);
    expect(page.events[0]).toMatchObject({ actor: "alice", outcome: "success" });
  });

  it("fails open: login still succeeds when the audit write fails", async () => {
    closeAudit();

    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "alice", password: "correct horse" },
    });

    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run (in `server/`): `npm test -- test/auth-routes.test.ts`
Expected: FAIL — cannot resolve `./helpers.js`… then after scaffolding exists, failures like route not found / buildApp not throwing. (The setup file also now requires `FLEET_SESSION_SECRET`; existing suites still pass because buildApp doesn't read it yet.)

- [ ] **Step 5: Create `server/src/routes/auth.ts`**

```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticate, loadUsers } from "../auth.js";
import { recordEvent, type NewAuditEvent } from "../audit.js";
import type { ApiError, LoginRequest } from "../types.js";

/**
 * Fail-open audit policy for this observe-only slice: a failed audit write is
 * logged but never blocks the request. Phase 2 mutating endpoints must
 * fail closed instead (refuse the action when the audit write fails).
 */
function audit(request: FastifyRequest, event: NewAuditEvent): void {
  try {
    recordEvent(event);
  } catch (err) {
    request.log.error({ err }, "audit write failed");
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/login", async (request, reply) => {
    const { username, password } = (request.body ?? {}) as Partial<LoginRequest>;
    if (typeof username !== "string" || typeof password !== "string") {
      const body: ApiError = { error: "username and password are required" };
      return reply.code(400).send(body);
    }

    const user = authenticate(username, password, loadUsers());
    if (!user) {
      audit(request, {
        actor: username,
        role: null,
        action: "auth.login_failed",
        outcome: "failure",
        ip: request.ip,
      });
      const body: ApiError = { error: "Invalid credentials" };
      return reply.code(401).send(body);
    }

    request.session.set("user", user);
    request.session.set("issuedAt", Date.now());
    audit(request, {
      actor: user.username,
      role: user.role,
      action: "auth.login",
      outcome: "success",
      ip: request.ip,
    });
    return user;
  });

  app.post("/api/logout", async (request, reply) => {
    const user = request.session.get("user");
    request.session.delete();
    if (user) {
      audit(request, {
        actor: user.username,
        role: user.role,
        action: "auth.logout",
        outcome: "success",
        ip: request.ip,
      });
    }
    return reply.code(204).send();
  });

  // Session probe. Checks the session itself (not just the gate) so it works
  // and is testable independent of the gate hook.
  app.get("/api/me", async (request, reply) => {
    const user = request.session.get("user");
    if (!user) {
      const body: ApiError = { error: "Unauthorized" };
      return reply.code(401).send(body);
    }
    return user;
  });
}
```

- [ ] **Step 6: Wire the session into `server/src/app.ts`**

Replace the full file with:

```ts
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import cors from "@fastify/cors";
import secureSession from "@fastify/secure-session";
import { containerRoutes } from "./routes/containers.js";
import { authRoutes } from "./routes/auth.js";
import { closeAudit, initAudit } from "./audit.js";
import { pingDocker } from "./docker.js";
import type { SessionUser } from "./types.js";

declare module "@fastify/secure-session" {
  interface SessionData {
    user: SessionUser;
    issuedAt: number;
  }
}

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
}

/**
 * Builds the Fastify app with all routes registered, but not listening —
 * index.ts calls listen(); tests drive it via app.inject().
 */
export async function buildApp(
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const secret = process.env.FLEET_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("FLEET_SESSION_SECRET must be set to at least 32 characters");
  }

  const app = Fastify({ logger: opts.logger ?? false });

  // In production the frontend is served from the same origin (or behind
  // the same reverse proxy), so CORS is only open for local dev.
  await app.register(cors, {
    origin: process.env.NODE_ENV === "production" ? false : true,
  });

  await app.register(secureSession, {
    secret,
    salt: "fleet-console-v1", // must be exactly 16 chars; key = pbkdf2(secret, salt)
    cookieName: "session",
    cookie: {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      // Compose serves plain HTTP on a trusted network by default; enable
      // behind TLS termination.
      secure: process.env.FLEET_COOKIE_SECURE === "true",
    },
  });

  initAudit(process.env.AUDIT_DB_PATH ?? "./data/audit.db");
  app.addHook("onClose", async () => closeAudit());

  app.get("/api/health", async () => {
    const dockerReachable = await pingDocker();
    return {
      ok: dockerReachable,
      docker: dockerReachable ? "connected" : "unreachable",
      uptimeSeconds: Math.round(process.uptime()),
    };
  });

  await app.register(authRoutes);
  await app.register(containerRoutes);

  return app;
}
```

- [ ] **Step 7: Boot validation in `server/src/index.ts`**

Replace the full file with:

```ts
import { buildApp } from "./app.js";
import { loadUsers } from "./auth.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  if (loadUsers().length === 0) {
    throw new Error(
      "No users configured — set FLEET_USERS (JSON array) or FLEET_USERS_FILE. " +
        'Generate a hash with: npm run hash-password -- "<password>"',
    );
  }

  const app = await buildApp({
    logger:
      process.env.NODE_ENV === "production"
        ? true
        : {
            transport: {
              target: "pino-pretty",
              options: { translateTime: "HH:MM:ss" },
            },
          },
  });

  await app.listen({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error("Fatal: server failed to start", err);
  process.exit(1);
});
```

- [ ] **Step 8: Run tests to verify they pass**

Run (in `server/`): `npm test`
Expected: ALL suites pass — the new auth-routes tests and the existing docker/routes/auth/audit suites. (Existing `routes.test.ts` still passes because the gate doesn't exist yet — reads are still open.)

- [ ] **Step 9: Typecheck + commit**

Run (in `server/`): `npm run typecheck` → no errors.

```bash
git add server/src/app.ts server/src/index.ts server/src/routes/auth.ts server/vitest.config.ts server/test/setup.ts server/test/helpers.ts server/test/auth-routes.test.ts server/package.json server/package-lock.json
git commit -m "feat: session cookie login/logout/me with audited auth events"
```

---

### Task 4: Auth gate over the API

**Files:**
- Modify: `server/src/app.ts` (add gate hook)
- Modify: `server/test/routes.test.ts` (log in before hitting protected routes; gate tests)

**Interfaces:**
- Consumes: session keys `user`/`issuedAt` and `loginAs` helper (Task 3).
- Produces: every `/api/*` route except `/api/health` and `/api/login` returns `401 {"error":"Unauthorized"}` without a valid, unexpired session. Sessions expire 8 hours after `issuedAt`. Later tasks (audit route) get gating for free.

- [ ] **Step 1: Add failing gate tests and update existing route tests**

Replace `server/test/routes.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/docker.js", () => ({
  getContainerStats: vi.fn(),
  getFleetOverview: vi.fn(),
  listContainers: vi.fn(),
  pingDocker: vi.fn(),
}));

import * as dockerApi from "../src/docker.js";
import { buildApp } from "../src/app.js";
import { loginAs } from "./helpers.js";

const mocked = vi.mocked(dockerApi);

let app: FastifyInstance;
let cookies: { session: string };

beforeEach(async () => {
  vi.resetAllMocks();
  app = await buildApp();
  cookies = await loginAs(app);
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

describe("auth gate", () => {
  it.each(["/api/overview", "/api/containers", "/api/containers/abc123/stats"])(
    "rejects %s without a session",
    async (url) => {
      const res = await app.inject({ url });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Unauthorized" });
    },
  );

  it("leaves /api/health open", async () => {
    mocked.pingDocker.mockResolvedValue(true);

    const res = await app.inject({ url: "/api/health" });

    expect(res.statusCode).toBe(200);
  });

  it("rejects an expired session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-09T08:00:00Z"));
    const oldCookies = await loginAs(app);

    vi.setSystemTime(new Date("2026-07-09T16:00:01Z")); // 8h + 1s later
    const res = await app.inject({ url: "/api/overview", cookies: oldCookies });

    expect(res.statusCode).toBe(401);
  });

  it("accepts a session younger than the TTL", async () => {
    mocked.getFleetOverview.mockResolvedValue({
      total: 0,
      running: 0,
      stopped: 0,
      dockerVersion: "27.1.1",
      hostName: "docker-host",
    });

    const res = await app.inject({ url: "/api/overview", cookies });

    expect(res.statusCode).toBe(200);
  });
});

describe("GET /api/health", () => {
  it("reports connected when the Docker socket responds", async () => {
    mocked.pingDocker.mockResolvedValue(true);

    const res = await app.inject({ url: "/api/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      docker: "connected",
      uptimeSeconds: expect.any(Number),
    });
  });

  it("reports unreachable when the Docker socket is down", async () => {
    mocked.pingDocker.mockResolvedValue(false);

    const res = await app.inject({ url: "/api/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, docker: "unreachable" });
  });
});

describe("GET /api/containers", () => {
  it("returns the wrapper's container list", async () => {
    const summary = {
      id: "abcdef1234567890",
      shortId: "abcdef123456",
      name: "web-1",
      image: "nginx:1.27",
      state: "running" as const,
      status: "Up 2 hours",
      createdAt: "2026-07-07T21:00:00.000Z",
      ports: [],
    };
    mocked.listContainers.mockResolvedValue([summary]);

    const res = await app.inject({ url: "/api/containers", cookies });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([summary]);
  });
});

describe("GET /api/overview", () => {
  it("returns the fleet overview", async () => {
    const overview = {
      total: 3,
      running: 1,
      stopped: 2,
      dockerVersion: "27.1.1",
      hostName: "docker-host",
    };
    mocked.getFleetOverview.mockResolvedValue(overview);

    const res = await app.inject({ url: "/api/overview", cookies });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(overview);
  });
});

describe("GET /api/containers/:id/stats", () => {
  it("returns stats for a valid id", async () => {
    const stats = {
      id: "abc123",
      cpuPercent: 40,
      memoryUsageBytes: 104857600,
      memoryLimitBytes: 419430400,
      memoryPercent: 25,
      sampledAt: "2026-07-08T04:00:00.000Z",
    };
    mocked.getContainerStats.mockResolvedValue(stats);

    const res = await app.inject({ url: "/api/containers/abc123/stats", cookies });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(stats);
  });

  it("rejects ids with unexpected characters before touching Docker", async () => {
    const res = await app.inject({ url: "/api/containers/bad$id/stats", cookies });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid container id" });
    expect(mocked.getContainerStats).not.toHaveBeenCalled();
  });

  it("maps Docker 404s to a 404 response", async () => {
    mocked.getContainerStats.mockRejectedValue(
      Object.assign(new Error("no such container"), { statusCode: 404 }),
    );

    const res = await app.inject({ url: "/api/containers/deadbeef/stats", cookies });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: "Container not found",
      detail: "no such container",
    });
  });

  it("maps other Docker failures to a 502 response", async () => {
    mocked.getContainerStats.mockRejectedValue(new Error("socket hang up"));

    const res = await app.inject({ url: "/api/containers/abc123/stats", cookies });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: "Stats unavailable",
      detail: "socket hang up",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify the gate tests fail**

Run (in `server/`): `npm test -- test/routes.test.ts`
Expected: the four "auth gate" reject/expiry tests FAIL (routes still respond 200/etc. without a session); the rest pass.

- [ ] **Step 3: Add the gate hook to `server/src/app.ts`**

Add near the top of the file (module scope, after the imports):

```ts
import type { ApiError } from "./types.js"; // merge into the existing types import

/** /api paths reachable without a session. */
const OPEN_API_PATHS = new Set(["/api/health", "/api/login"]);

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
```

Inside `buildApp()`, immediately after the `app.addHook("onClose", ...)` line and before the `/api/health` route, add:

```ts
  // Auth gate: every /api route except the open set requires a valid,
  // unexpired session. New routes are therefore protected by default.
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/") || OPEN_API_PATHS.has(path)) return;

    const user = request.session.get("user");
    const issuedAt = request.session.get("issuedAt");
    if (
      !user ||
      typeof issuedAt !== "number" ||
      Date.now() - issuedAt > SESSION_TTL_MS
    ) {
      request.session.delete();
      const body: ApiError = { error: "Unauthorized" };
      return reply.code(401).send(body);
    }
  });
```

- [ ] **Step 4: Run the full suite to verify everything passes**

Run (in `server/`): `npm test`
Expected: PASS — all suites, including the auth-routes suite from Task 3 (its `/api/me` and logout tests now also pass through the gate).

- [ ] **Step 5: Typecheck + commit**

Run (in `server/`): `npm run typecheck` → no errors.

```bash
git add server/src/app.ts server/test/routes.test.ts
git commit -m "feat: require a session for all API routes except health and login"
```

---

### Task 5: Rate-limit the login route

**Files:**
- Modify: `server/package.json` (dep via npm install)
- Modify: `server/src/app.ts` (register plugin)
- Modify: `server/src/routes/auth.ts` (route config)
- Test: `server/test/auth-routes.test.ts` (append)

**Interfaces:**
- Consumes: login route (Task 3).
- Produces: `POST /api/login` returns `429` after 5 attempts within 1 minute from one IP. No other route is rate-limited.

- [ ] **Step 1: Install @fastify/rate-limit**

Run (in `server/`):

```bash
npm install @fastify/rate-limit
```

- [ ] **Step 2: Write the failing test**

Append to `server/test/auth-routes.test.ts`:

```ts
describe("login rate limiting", () => {
  it("returns 429 after 5 attempts in a minute", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "alice", password: "wrong" },
      });
      expect(res.statusCode).toBe(401);
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "alice", password: "correct horse" },
    });

    expect(blocked.statusCode).toBe(429);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run (in `server/`): `npm test -- test/auth-routes.test.ts`
Expected: the new test FAILS (6th attempt returns 200, not 429).

- [ ] **Step 4: Register the plugin and scope it to the login route**

In `server/src/app.ts`, add the import:

```ts
import rateLimit from "@fastify/rate-limit";
```

and register it right after the `secureSession` registration (rate limiting is opt-in per route via `global: false`):

```ts
  await app.register(rateLimit, { global: false });
```

In `server/src/routes/auth.ts`, change the login route declaration from
`app.post("/api/login", async (request, reply) => {` to:

```ts
  app.post(
    "/api/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
```

(and close the added parenthesis at the end of that handler: `},` becomes `},\n  );`).

- [ ] **Step 5: Run the full suite**

Run (in `server/`): `npm test`
Expected: PASS. Note: each test builds a fresh app, so rate-limit counters never leak between tests; `loginAs` performs a single attempt.

- [ ] **Step 6: Typecheck + commit**

Run (in `server/`): `npm run typecheck` → no errors.

```bash
git add server/src/app.ts server/src/routes/auth.ts server/test/auth-routes.test.ts server/package.json server/package-lock.json
git commit -m "feat: rate-limit login to 5 attempts per minute per IP"
```

---

### Task 6: Audit read API (`GET /api/audit`)

**Files:**
- Create: `server/src/routes/audit.ts`
- Modify: `server/src/app.ts` (register route)
- Test: `server/test/audit-routes.test.ts`

**Interfaces:**
- Consumes: `queryEvents` (Task 2), gate (Task 4), `loginAs` (Task 3).
- Produces: `GET /api/audit?limit&offset&actor&action` → `AuditPage` (`{events, total}`), newest first, `limit` default 50 / clamped to [1, 200], `offset` ≥ 0. Session required (gate). Any authenticated user may read it in this slice — role restriction is future work.

- [ ] **Step 1: Write the failing test**

Create `server/test/audit-routes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { recordEvent } from "../src/audit.js";
import { loginAs } from "./helpers.js";
import type { AuditPage } from "../src/types.js";

let app: FastifyInstance;
let cookies: { session: string };

beforeEach(async () => {
  app = await buildApp();
  cookies = await loginAs(app); // also writes one auth.login event
});

afterEach(async () => {
  await app.close();
});

describe("GET /api/audit", () => {
  it("requires a session", async () => {
    const res = await app.inject({ url: "/api/audit" });

    expect(res.statusCode).toBe(401);
  });

  it("returns events newest first with a total", async () => {
    recordEvent({ actor: "bob", role: "viewer", action: "auth.logout", outcome: "success" });

    const res = await app.inject({ url: "/api/audit", cookies });

    expect(res.statusCode).toBe(200);
    const page = res.json() as AuditPage;
    expect(page.total).toBe(2); // loginAs + the manual event
    expect(page.events[0]?.action).toBe("auth.logout");
    expect(page.events[1]?.action).toBe("auth.login");
  });

  it("applies limit/offset and filters", async () => {
    for (let i = 0; i < 3; i++) {
      recordEvent({ actor: "bob", role: "viewer", action: "auth.logout", outcome: "success" });
    }

    const limited = await app.inject({ url: "/api/audit?limit=2", cookies });
    expect((limited.json() as AuditPage).events).toHaveLength(2);

    const offset = await app.inject({ url: "/api/audit?limit=2&offset=3", cookies });
    expect((offset.json() as AuditPage).events).toHaveLength(1);

    const filtered = await app.inject({ url: "/api/audit?actor=bob&action=auth.logout", cookies });
    const page = filtered.json() as AuditPage;
    expect(page.total).toBe(3);
    expect(page.events.every((e) => e.actor === "bob")).toBe(true);
  });

  it("clamps nonsense pagination values instead of failing", async () => {
    const res = await app.inject({ url: "/api/audit?limit=99999&offset=-4", cookies });

    expect(res.statusCode).toBe(200);
    expect((res.json() as AuditPage).total).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (in `server/`): `npm test -- test/audit-routes.test.ts`
Expected: FAIL — `/api/audit` returns 404 (route not registered).

- [ ] **Step 3: Create `server/src/routes/audit.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { queryEvents, type AuditQuery } from "../audit.js";

interface AuditQuerystring {
  limit?: string;
  offset?: string;
  actor?: string;
  action?: string;
}

/**
 * Read-only audit log. Session required via the global gate. Any
 * authenticated user may read it in this slice; restricting to admin comes
 * with role enforcement.
 */
export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: AuditQuerystring }>("/api/audit", async (request) => {
    const rawLimit = Number(request.query.limit ?? 50);
    const rawOffset = Number(request.query.offset ?? 0);
    const query: AuditQuery = {
      limit: Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200)
        : 50,
      offset: Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0,
    };
    if (request.query.actor) query.actor = request.query.actor;
    if (request.query.action) query.action = request.query.action;
    return queryEvents(query);
  });
}
```

- [ ] **Step 4: Register it in `server/src/app.ts`**

Add the import:

```ts
import { auditRoutes } from "./routes/audit.js";
```

and register it next to the other routes (after `authRoutes`):

```ts
  await app.register(auditRoutes);
```

- [ ] **Step 5: Run the full suite, typecheck, commit**

Run (in `server/`): `npm test` then `npm run typecheck` — all green.

```bash
git add server/src/routes/audit.ts server/src/app.ts server/test/audit-routes.test.ts
git commit -m "feat: add paginated, filterable audit read API"
```

---

### Task 7: Web contract types + API client

**Files:**
- Modify: `web/src/types.ts` (append mirrored types)
- Modify: `web/src/api.ts`

**Interfaces:**
- Consumes: server API shapes from Tasks 3 and 6.
- Produces (Tasks 8–9 rely on these):
  - Mirrored types `Role`, `SessionUser`, `LoginRequest`, `AuditEvent`, `AuditPage` in `web/src/types.ts`
  - `setUnauthorizedHandler(handler: (() => void) | null): void`
  - `api.login(username: string, password: string): Promise<SessionUser>` — throws `Error` whose message is the server's `error` field (e.g. "Invalid credentials")
  - `api.logout(): Promise<void>`
  - `api.me(): Promise<SessionUser | null>` — null means "not logged in", never triggers the unauthorized handler
  - `api.audit(params: { limit?: number; offset?: number; actor?: string; action?: string }): Promise<AuditPage>`

- [ ] **Step 1: Mirror the types**

Append to `web/src/types.ts` **exactly** the same block added to `server/src/types.ts` in Task 1 Step 1 (from the `// --- Auth + audit` comment through `AuditPage`). The two files must stay in sync.

- [ ] **Step 2: Extend `web/src/api.ts`**

Replace the top of the file (imports through the `api` object) with:

```ts
import { useEffect, useRef, useState } from "react";
import type {
  AuditPage,
  ContainerStats,
  ContainerSummary,
  FleetOverview,
  SessionUser,
} from "./types";

let onUnauthorized: (() => void) | null = null;

/** Called whenever an API request returns 401 — the app flips to the login screen. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (res.status === 401) {
    onUnauthorized?.();
    throw new Error(`${path} → HTTP 401`);
  }
  if (!res.ok) {
    throw new Error(`${path} → HTTP ${res.status}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

function getJson<T>(path: string): Promise<T> {
  return request<T>(path);
}

export const api = {
  overview: () => getJson<FleetOverview>("/api/overview"),
  containers: () => getJson<ContainerSummary[]>("/api/containers"),
  stats: (id: string) => getJson<ContainerStats>(`/api/containers/${id}/stats`),

  /** Throws with the server's error message (e.g. "Invalid credentials"). */
  login: async (username: string, password: string): Promise<SessionUser> => {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Login failed (HTTP ${res.status})`);
    }
    return res.json() as Promise<SessionUser>;
  },

  logout: () => request<void>("/api/logout", { method: "POST" }),

  /** Session probe: null means "not logged in" (never an error, never the 401 handler). */
  me: async (): Promise<SessionUser | null> => {
    const res = await fetch("/api/me");
    if (res.status === 401) return null;
    if (!res.ok) throw new Error(`/api/me → HTTP ${res.status}`);
    return res.json() as Promise<SessionUser>;
  },

  audit: (params: { limit?: number; offset?: number; actor?: string; action?: string }) => {
    const qs = new URLSearchParams();
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    if (params.actor) qs.set("actor", params.actor);
    if (params.action) qs.set("action", params.action);
    return getJson<AuditPage>(`/api/audit?${qs.toString()}`);
  },
};
```

Keep `Polled`, `usePolling`, and `formatBytes` below unchanged.

- [ ] **Step 3: Typecheck + build**

Run (in `web/`): `npm run typecheck` then `npm run build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add web/src/types.ts web/src/api.ts
git commit -m "feat: mirror auth/audit contract types and extend web API client"
```

---

### Task 8: Login screen and session flow in the SPA

**Files:**
- Create: `web/src/components/LoginForm.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css` (append)

**Interfaces:**
- Consumes: `api.login`, `api.logout`, `api.me`, `setUnauthorizedHandler`, `SessionUser` (Task 7).
- Produces: `App` renders `LoginForm` when logged out and the `Console` (existing dashboard + header session controls) when logged in. Task 9 adds the view toggle inside `Console`.

- [ ] **Step 1: Create `web/src/components/LoginForm.tsx`**

```tsx
import { useState, type FormEvent } from "react";
import { api } from "../api";
import type { SessionUser } from "../types";

export function LoginForm({ onLogin }: { onLogin: (user: SessionUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.login(username, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Fleet Console</h1>
        <p className="login-hint">Sign in to view the fleet</p>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !username || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Rework `web/src/App.tsx`**

Replace the full file with (this is the existing dashboard moved into a `Console` component — the JSX inside `Console` is unchanged apart from the header's new session controls):

```tsx
import { useEffect, useState } from "react";
import { api, setUnauthorizedHandler, usePolling } from "./api";
import { FleetTable } from "./components/FleetTable";
import { LoginForm } from "./components/LoginForm";
import type { SessionUser } from "./types";

const POLL_MS = 5000;

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setAuthChecked(true));
    return () => setUnauthorizedHandler(null);
  }, []);

  if (!authChecked) {
    return (
      <div className="shell">
        <div className="empty">
          <p>Checking session…</p>
        </div>
      </div>
    );
  }
  if (!user) {
    return <LoginForm onLogin={setUser} />;
  }
  return <Console user={user} onLogout={() => setUser(null)} />;
}

function Console({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const overview = usePolling(api.overview, POLL_MS);
  const containers = usePolling(api.containers, POLL_MS);

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      // The session may already be gone — logging out locally either way.
    }
    onLogout();
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1>Fleet Console</h1>
          <p className="host">
            {overview.data
              ? `host ${overview.data.hostName} · docker ${overview.data.dockerVersion}`
              : "connecting to host…"}
          </p>
        </div>
        <dl className="counters">
          <div className="counter">
            <dt>Running</dt>
            <dd className="ok">{overview.data?.running ?? "–"}</dd>
          </div>
          <div className="counter">
            <dt>Stopped</dt>
            <dd className="down">{overview.data?.stopped ?? "–"}</dd>
          </div>
          <div className="counter">
            <dt>Total</dt>
            <dd>{overview.data?.total ?? "–"}</dd>
          </div>
        </dl>
        <div className="session">
          <span className="session-user">{user.username}</span>
          <button className="logout" onClick={() => void handleLogout()}>
            Log out
          </button>
        </div>
      </header>

      {containers.error && (
        <div className="banner" role="alert">
          Can’t reach the Fleet Console API ({containers.error}). Check that
          the server is running and has access to the Docker socket.
        </div>
      )}

      <main>
        {containers.loading ? (
          <div className="empty">
            <p>Loading fleet…</p>
          </div>
        ) : (
          <FleetTable containers={containers.data ?? []} />
        )}
      </main>

      <footer className="statusline">
        <span>
          refresh {POLL_MS / 1000}s
          {containers.lastUpdated
            ? ` · last update ${containers.lastUpdated.toLocaleTimeString()}`
            : ""}
        </span>
        <span>fleet-console v0.2 · observe-only · authenticated</span>
      </footer>
    </div>
  );
}
```

- [ ] **Step 3: Append login/session styles to `web/src/styles.css`**

```css
/* Login screen */
.login-screen {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}

.login-card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 32px 28px;
  width: 100%;
  max-width: 340px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.login-card h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.login-hint {
  margin: -8px 0 4px;
  font-size: 12px;
  color: var(--text-dim);
}

.login-card label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-dim);
}

.login-card input {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 14px;
}

.login-card input:focus {
  outline: none;
  border-color: var(--led-paused);
}

.login-card button {
  background: var(--surface-raised);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 9px 12px;
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

.login-card button:disabled {
  opacity: 0.5;
  cursor: default;
}

.login-error {
  margin: 0;
  font-size: 13px;
  color: var(--led-down);
}

/* Header session controls */
.session {
  display: flex;
  align-items: center;
  gap: 10px;
}

.session-user {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
}

.logout {
  background: none;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 5px 10px;
  color: var(--text-dim);
  font-family: var(--font-sans);
  font-size: 12px;
  cursor: pointer;
}

.logout:hover {
  color: var(--text);
  border-color: var(--text-dim);
}
```

- [ ] **Step 4: Typecheck + build**

Run (in `web/`): `npm run typecheck` then `npm run build`
Expected: both succeed.

- [ ] **Step 5: Manual smoke test (requires a local Docker daemon; skip if unavailable)**

In `server/` (Git Bash):

```bash
FLEET_SESSION_SECRET="dev-secret-dev-secret-dev-secret-xx" \
FLEET_USERS="[{\"username\":\"alice\",\"role\":\"admin\",\"passwordHash\":\"$(npm run --silent hash-password -- 'demo')\"}]" \
npm run dev
```

In `web/`: `npm run dev`, open http://localhost:5173. Expected: login screen; wrong password shows "Invalid credentials"; `alice`/`demo` lands on the dashboard with the username and Log out in the header; Log out returns to the login screen.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/LoginForm.tsx web/src/App.tsx web/src/styles.css
git commit -m "feat: login screen and session-aware shell in the SPA"
```

---

### Task 9: Audit log view + view toggle

**Files:**
- Create: `web/src/components/AuditLog.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css` (append)

**Interfaces:**
- Consumes: `api.audit`, `AuditEvent` (Task 7); `Console` component (Task 8).
- Produces: header tabs **Dashboard | Audit log**; the audit view lists events with filters and "Load more".

- [ ] **Step 1: Create `web/src/components/AuditLog.tsx`**

```tsx
import { useEffect, useState } from "react";
import { api } from "../api";
import type { AuditEvent } from "../types";

const PAGE_SIZE = 50;

export function AuditLog() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load(offset: number, replace: boolean) {
    setLoading(true);
    setError(null);
    try {
      const page = await api.audit({
        limit: PAGE_SIZE,
        offset,
        ...(actor ? { actor } : {}),
        ...(action ? { action } : {}),
      });
      setTotal(page.total);
      setEvents((prev) => (replace ? page.events : [...prev, ...page.events]));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit log");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(0, true);
    // Refetch from the top whenever a filter changes.
  }, [actor, action]);

  return (
    <section className="audit">
      <div className="audit-filters">
        <input
          placeholder="Filter by user"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
        />
        <input
          placeholder="Filter by action"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        />
        <span className="audit-count">
          {total} event{total === 1 ? "" : "s"}
        </span>
      </div>

      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      {events.length === 0 && !loading ? (
        <div className="empty">
          <p>No audit events match.</p>
        </div>
      ) : (
        <table className="fleet audit-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>User</th>
              <th>Action</th>
              <th>Target</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="short-id">{new Date(e.ts).toLocaleString()}</td>
                <td className="name">{e.actor}</td>
                <td className="image">{e.action}</td>
                <td className="short-id">{e.target ?? "—"}</td>
                <td className={e.outcome === "success" ? "outcome-ok" : "outcome-fail"}>
                  {e.outcome}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {events.length < total && (
        <button
          className="audit-more"
          disabled={loading}
          onClick={() => void load(events.length, false)}
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Add the view toggle to `Console` in `web/src/App.tsx`**

Add the import at the top:

```tsx
import { AuditLog } from "./components/AuditLog";
```

Inside `Console`, add view state on the first line of the component body:

```tsx
  const [view, setView] = useState<"dashboard" | "audit">("dashboard");
```

In the header, insert a tab nav between the title `<div>` and the `<dl className="counters">`:

```tsx
        <nav className="tabs">
          <button
            className={view === "dashboard" ? "tab active" : "tab"}
            onClick={() => setView("dashboard")}
          >
            Dashboard
          </button>
          <button
            className={view === "audit" ? "tab active" : "tab"}
            onClick={() => setView("audit")}
          >
            Audit log
          </button>
        </nav>
```

Replace the error-banner + `<main>` block with a view switch (the dashboard branch is the existing content, unchanged):

```tsx
      {view === "dashboard" ? (
        <>
          {containers.error && (
            <div className="banner" role="alert">
              Can’t reach the Fleet Console API ({containers.error}). Check that
              the server is running and has access to the Docker socket.
            </div>
          )}

          <main>
            {containers.loading ? (
              <div className="empty">
                <p>Loading fleet…</p>
              </div>
            ) : (
              <FleetTable containers={containers.data ?? []} />
            )}
          </main>
        </>
      ) : (
        <main>
          <AuditLog />
        </main>
      )}
```

- [ ] **Step 3: Append tab and audit styles to `web/src/styles.css`**

```css
/* View tabs */
.tabs {
  display: flex;
  gap: 6px;
}

.tab {
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 6px 12px;
  color: var(--text-dim);
  font-family: var(--font-sans);
  font-size: 13px;
  cursor: pointer;
}

.tab:hover {
  color: var(--text);
}

.tab.active {
  background: var(--surface);
  border-color: var(--line);
  color: var(--text);
}

/* Audit view */
.audit {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.audit-filters {
  display: flex;
  gap: 8px;
  align-items: center;
}

.audit-filters input {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 7px 10px;
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 13px;
  width: 180px;
}

.audit-filters input:focus {
  outline: none;
  border-color: var(--led-paused);
}

.audit-count {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
}

.outcome-ok {
  color: var(--led-ok);
  font-family: var(--font-mono);
  font-size: 12px;
}

.outcome-fail {
  color: var(--led-down);
  font-family: var(--font-mono);
  font-size: 12px;
}

.audit-more {
  align-self: center;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 16px;
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 13px;
  cursor: pointer;
}

.audit-more:disabled {
  opacity: 0.5;
  cursor: default;
}
```

- [ ] **Step 4: Typecheck + build**

Run (in `web/`): `npm run typecheck` then `npm run build`
Expected: both succeed.

- [ ] **Step 5: Manual smoke test (same setup as Task 8 Step 5; skip if no Docker daemon)**

Log in, click **Audit log**: the table shows the login events (including failed attempts) newest first; typing `alice` into the user filter narrows the list; **Dashboard** returns to the fleet table.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/AuditLog.tsx web/src/App.tsx web/src/styles.css
git commit -m "feat: audit log view with filters behind a header view toggle"
```

---

### Task 10: Deployment (Dockerfile, compose) + docs (README, CLAUDE.md)

**Files:**
- Modify: `server/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: env vars defined in Tasks 3–5 (`FLEET_SESSION_SECRET`, `FLEET_USERS`, `FLEET_USERS_FILE`, `AUDIT_DB_PATH`, `FLEET_COOKIE_SECURE`).
- Produces: a compose stack that boots with auth configured and persists the audit DB.

- [ ] **Step 1: Fix and update `server/Dockerfile`**

Two changes: (a) latent bug — the build stage never copies `tsconfig.build.json`, which `npm run build` requires, so the image build is currently broken; (b) switch `node:22-alpine` → `node:22-slim` because `better-sqlite3` and `sodium-native` (secure-session's crypto) ship prebuilt binaries for glibc — on alpine/musl they compile from source and would need a toolchain in **both** stages.

Replace the file with:

```dockerfile
# ---- build stage ----
# node:22-slim (glibc), not alpine: better-sqlite3 and sodium-native ship
# prebuilt glibc binaries; musl would compile from source in both stages.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Update `docker-compose.yml`**

Replace the `server:` service and add a top-level `volumes:` key (web + demo services unchanged):

```yaml
services:
  server:
    build: ./server
    environment:
      NODE_ENV: production
      # Both required — compose reads them from a .env file next to this
      # file or from the shell. See README "Authentication & audit log".
      FLEET_SESSION_SECRET: ${FLEET_SESSION_SECRET:?set FLEET_SESSION_SECRET (32+ chars) in .env}
      FLEET_USERS: ${FLEET_USERS:?set FLEET_USERS (JSON array) in .env}
      AUDIT_DB_PATH: /data/audit.db
      FLEET_COOKIE_SECURE: ${FLEET_COOKIE_SECURE:-false}
    volumes:
      # Read-only Docker socket: the console can observe the host's
      # containers. Phase 2 (start/stop actions) will need :rw — a good
      # security tradeoff to discuss in the README.
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - audit-data:/data
    restart: unless-stopped
```

At the bottom of the file add:

```yaml
volumes:
  audit-data:
```

- [ ] **Step 3: Update `README.md`**

Make these changes:

1. Status line (line 7) — replace with:

```markdown
> **Status: Phase 1.5 (read-only visibility + auth & audit log).** See [Roadmap](#roadmap).
```

2. After the "Running it" section, add a new section:

````markdown
## Authentication & audit log

The console requires a login. Operators are named local users defined in an
env var (or file) — no external identity provider.

**1. Generate a password hash:**

```bash
cd server && npm run hash-password -- "s3cret"
# → scrypt:9f3a…:c41b…
```

**2. Configure users and a session secret.** For `docker compose`, put them
in a `.env` file next to `docker-compose.yml`:

```bash
FLEET_SESSION_SECRET=<any random string, 32+ characters>
FLEET_USERS=[{"username":"alice","role":"admin","passwordHash":"scrypt:…"}]
```

| Env var | Purpose | Default |
|---|---|---|
| `FLEET_SESSION_SECRET` | Session cookie encryption key material (≥ 32 chars) | required |
| `FLEET_USERS` | JSON array of `{username, role, passwordHash}` | — |
| `FLEET_USERS_FILE` | Path to the same JSON in a file (wins over `FLEET_USERS`) | — |
| `AUDIT_DB_PATH` | SQLite audit DB location | `./data/audit.db` |
| `FLEET_COOKIE_SECURE` | Set the cookie's `Secure` flag (enable behind TLS) | `false` |

Roles (`admin` / `operator` / `viewer`) are stored on the session and audit
rows but not yet enforced — enforcement lands with Phase 2 actions.

Every login, failed login, and logout is recorded in a SQLite audit log
(compose persists it in the `audit-data` volume) and is browsable from the
**Audit log** tab in the UI. `GET /api/audit` serves it with pagination and
`actor`/`action` filters.
````

3. API table — replace with:

```markdown
| Route | Auth | Returns |
|---|---|---|
| `GET /api/health` | none | Server + Docker socket reachability |
| `POST /api/login` | none (rate-limited) | Sets session cookie, returns `{username, role}` |
| `POST /api/logout` | session | Clears the session cookie |
| `GET /api/me` | session | Current session user |
| `GET /api/overview` | session | Fleet counts, Docker version, hostname |
| `GET /api/containers` | session | All containers (including stopped) |
| `GET /api/containers/:id/stats` | session | One-shot CPU/memory sample |
| `GET /api/audit` | session | Paginated audit events (`limit`, `offset`, `actor`, `action`) |
```

4. Roadmap — replace the whole Roadmap list with:

```markdown
- [x] **Phase 1 — visibility:** container list, states, CPU/memory, overview strip
- [x] **Phase 1.5 — auth + audit:** named-user login, session cookie, SQLite audit log with UI viewer
- [ ] **Phase 2 — actions:** start/stop/restart from the UI; live log streaming over WebSockets; socket mounted `rw`; role enforcement; mutating actions audited **fail-closed**
- [ ] **Phase 3 — deployment workflow:** pick an image tag, roll out to a container group, watch health, one-click rollback; CI/CD via GitHub Actions (lint → typecheck → build → push image → deploy)
- [ ] **Polish:** shared types package, web-package tests, README demo GIF
```

5. Security notes — replace the paragraph with:

```markdown
Mounting the Docker socket into a container is equivalent to root on the
host — that's why Phase 1 mounts it read-only and the app has no mutating
endpoints. The console now requires a named-user login (scrypt-hashed
passwords, encrypted HttpOnly session cookie, rate-limited login) and keeps
an audit log of auth events. Before Phase 2 lands, mutating endpoints must
enforce roles and fail closed when the audit write fails (see the design
spec). The stack still serves plain HTTP — put TLS in front (and set
`FLEET_COOKIE_SECURE=true`) before exposing port 8080 beyond a trusted
network.
```

- [ ] **Step 4: Update `CLAUDE.md`**

1. In Layout, extend the `server/` bullet:

```markdown
- `server/` — Fastify 5 + dockerode API (Node 22, ESM). All dockerode access goes through `src/docker.ts`; keep it the only module that touches dockerode (it's the mockable seam). Same pattern: `src/audit.ts` is the only module that touches better-sqlite3, and `src/auth.ts` the only one that reads user config / verifies passwords.
```

2. In Gotchas, replace the env vars line with:

```markdown
- Env vars (no .env.example): server `PORT` (4000), `HOST`, `DOCKER_SOCKET`, `NODE_ENV`, `FLEET_SESSION_SECRET` (required, ≥32 chars), `FLEET_USERS`/`FLEET_USERS_FILE`, `AUDIT_DB_PATH` (default `./data/audit.db`), `FLEET_COOKIE_SECURE`; web `VITE_API_TARGET` (dev proxy target).
```

3. Append two new gotchas:

```markdown
- All `/api/*` routes except `/api/health` and `/api/login` require a session — the `onRequest` gate in `app.ts` protects new routes by default. In tests, log in with `loginAs()` from `test/helpers.ts` and pass its result as `cookies:` to `app.inject`. Test env (secret, users, `:memory:` audit DB) is seeded by `test/setup.ts` via `vitest.config.ts`.
- Audit policy: this slice fails open (log + continue) when an audit write fails; Phase 2 mutating endpoints must fail closed. Don't "fix" the fail-open behavior in auth routes.
```

- [ ] **Step 5: Verify**

- Run (in `server/`): `npm run typecheck && npm test && npm run build` — all green.
- Run (in `web/`): `npm run typecheck && npm run build` — green.
- If a Docker daemon is available: create `.env` next to `docker-compose.yml` (secret + one user as in the README), then `docker compose up --build`; open http://localhost:8080 → login screen; sign in; Audit log tab shows the login. `docker compose down` afterwards (the `audit-data` volume persists). Skip if no daemon.

- [ ] **Step 6: Commit**

```bash
git add server/Dockerfile docker-compose.yml README.md CLAUDE.md
git commit -m "feat: wire auth env + audit volume into compose; fix server image build; document auth"
```

---

### Task 11: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full server check**

Run (in `server/`): `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; **all suites pass** (existing 23 + ~30 new across auth, audit, auth-routes, audit-routes, gate); build emits `dist/` without test files.

- [ ] **Step 2: Full web check**

Run (in `web/`): `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 3: Type mirror check**

Confirm the auth/audit type block in `server/src/types.ts` and `web/src/types.ts` is identical (the project's `/sync-types` skill does this if available; otherwise diff the two blocks by eye).

- [ ] **Step 4: Push and watch CI**

```bash
git push origin main
gh run watch
```

Expected: the CI workflow (typecheck + tests + builds for both packages) passes with no workflow changes.
