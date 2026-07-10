# Auth + Audit Log — Design

**Date:** 2026-07-09
**Status:** Approved
**Scope:** Authentication and audit-log infrastructure only. Mutating container
actions (start/stop/restart), role enforcement, and live log streaming are
explicitly out of scope and land as follow-up work items. The Docker socket
mount stays **read-only**.

## Goal

Fleet Console's roadmap gates Phase 2 (mutating container actions over an `rw`
socket) behind authentication and an audit log. This work item builds that
foundation: named operators log in, every API surface except the healthcheck
requires a session, and security-relevant events are durably recorded and
viewable in the UI.

## Decisions (settled during brainstorming)

| Decision | Choice |
|---|---|
| Identity model | Named local users, env-seeded, no external IdP |
| Session carrier | Encrypted HttpOnly session cookie (`@fastify/secure-session`) |
| Audit storage | SQLite file (`better-sqlite3`) in a compose volume |
| Scope | Auth + audit infra only; no mutating endpoints |
| Roles | `admin \| operator \| viewer` field stored now, enforced later |
| Auth coverage | Everything except `/api/health` (and `/api/login`) requires a session |
| Approach | Stateless encrypted cookie + scrypt hashing + SQLite for audit only |

Rejected alternatives: server-side sessions in SQLite (revocation not needed
for a small trusted-network team; adds a custom store and per-request DB
reads), hand-rolled HMAC tokens (own crypto plumbing, easy to get subtly
wrong), bearer tokens in the SPA (browser token storage, fetch plumbing),
reverse-proxy auth (complicates dev and compose).

## Server

### Users — `server/src/auth.ts`

- Operators defined via `FLEET_USERS` env var: JSON array of
  `{username, role, passwordHash}`. `FLEET_USERS_FILE` (path to the same JSON)
  is honored as an alternative so compose can mount a file; if both are set,
  the file wins.
- Roles: `admin | operator | viewer`. Stored in the session and stamped on
  audit rows. **Nothing enforces role differences in this slice** — enforcement
  arrives with mutating endpoints.
- Password hashing: Node built-in `crypto.scrypt` (no native bcrypt/argon2
  dependency). Stored format: `scrypt:<salt-hex>:<hash-hex>`. Verification is
  constant-time (`timingSafeEqual`).
- `npm run hash-password -- <password>` (script in `server/scripts/`) prints a
  hash so plaintext never lands in config.
- `auth.ts` is the only module that reads user config or verifies passwords —
  the same "one module owns the dependency" pattern as `docker.ts`.

### Session

- `@fastify/secure-session`, key derived from required `FLEET_SESSION_SECRET`
  env var (server refuses to boot without it outside of tests).
- Cookie: encrypted, `HttpOnly`, `SameSite=Strict`, `Path=/`. The `Secure`
  flag is controlled by `FLEET_COOKIE_SECURE` (default off — the compose stack
  serves plain HTTP on a trusted network; README recommends enabling it behind
  TLS termination).
- Payload: `{username, role, issuedAt}`. TTL 8 hours, enforced by checking
  `issuedAt` in the gate (secure-session cookies don't self-expire server-side).
- Logout clears the cookie. No server-side session state, therefore no
  revocation — accepted trade-off, mitigated by the short TTL.

### Routes — `server/src/routes/auth.ts`

| Route | Behavior |
|---|---|
| `POST /api/login` | Body `{username, password}`. Success: set session cookie, return `{username, role}`. Failure: generic `401 {error: "Invalid credentials"}` — no username enumeration. Rate-limited with `@fastify/rate-limit` scoped to this route only: 5 attempts per minute per IP, then `429`. |
| `POST /api/logout` | Clears the session, returns `204`. |
| `GET /api/me` | Returns `{username, role}` from the session, or `401`. The SPA's session probe on load. |

### Gate

Global `onRequest` hook registered in `buildApp()`:

- Open paths: `/api/health`, `/api/login`, and non-`/api` paths (static assets
  are nginx's concern in prod, but dev hits the gate too).
- Every other `/api/*` request without a valid, unexpired session gets
  `401 {error: "Unauthorized"}`.
- On success the hook decorates the request with the session user so handlers
  and audit code know the actor.

## Audit log

### Storage — `server/src/audit.ts`

`better-sqlite3` database at `AUDIT_DB_PATH` (default `./data/audit.db`),
WAL mode. `audit.ts` is the only module that touches better-sqlite3.

```sql
CREATE TABLE IF NOT EXISTS audit_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT    NOT NULL,  -- ISO 8601 UTC
  actor   TEXT    NOT NULL,  -- username (attempted username on failed login)
  role    TEXT,              -- NULL when unauthenticated (failed login)
  action  TEXT    NOT NULL,  -- dotted verb, e.g. 'auth.login'
  target  TEXT,              -- NULL for auth events; container id in Phase 2
  outcome TEXT    NOT NULL,  -- 'success' | 'failure'
  ip      TEXT,              -- request.ip
  detail  TEXT               -- optional JSON blob
);
```

The schema anticipates Phase 2: container actions slot in as
`container.start` / `container.stop` / `container.restart` with a `target`,
no migration needed.

API: `initAudit(path)`, `recordEvent(event)`, `queryEvents({limit, offset,
actor?, action?})` returning `{events, total}` newest-first. Tests use
`:memory:`.

### Events recorded in this slice

- `auth.login` (outcome `success`)
- `auth.login_failed` (outcome `failure`, actor = attempted username)
- `auth.logout` (outcome `success`)

### Failure policy (binding constraint)

- **This slice (observe-only):** if an audit write fails, log the error via
  pino and let the request succeed — a broken disk must not lock the team out
  of a read-only dashboard.
- **Phase 2 (mutating endpoints):** actions must **fail closed** — refuse the
  container action if the audit write fails. Phase 2 work must implement this;
  it is a requirement of this design, recorded here so it survives into that
  spec.

### Read API

`GET /api/audit?limit&offset&actor&action` → `{events, total}`, newest-first,
`limit` capped (default 50, max 200). Any authenticated user may read it in
this slice; restricting to `admin` happens when role enforcement lands.

## Web

- On load the SPA calls `GET /api/me`. No session → full-screen login form;
  success stores `{username, role}` in state and renders the dashboard.
- A shared fetch wrapper flips the app to the login screen when any API call
  returns `401` (mid-use session expiry), so `usePolling` doesn't spin against
  a dead session.
- Header: username, logout button, and a **Dashboard | Audit log** view toggle
  (conditional render — no router, per project convention).
- Audit view: table of time / actor / action / target / outcome, actor and
  action filter inputs, "Load more" button driving `offset`. Missing fields
  degrade to "—" per project pattern.
- `web/src/types.ts` mirrors the new contract types (`Role`, `SessionUser`,
  `LoginRequest`, `AuditEvent`, `AuditPage`) from `server/src/types.ts` —
  hand-mirrored as today; verify with `/sync-types`.

## Configuration & deployment

New env vars (server):

| Var | Purpose | Default |
|---|---|---|
| `FLEET_SESSION_SECRET` | Session encryption key material | required (boot failure if missing) |
| `FLEET_USERS` | JSON array of users | — |
| `FLEET_USERS_FILE` | Path to users JSON (wins over `FLEET_USERS`) | — |
| `AUDIT_DB_PATH` | SQLite file location | `./data/audit.db` |
| `FLEET_COOKIE_SECURE` | Set `Secure` flag on the session cookie (enable behind TLS) | off |

Compose: add a named volume mounted at `/data` for the audit DB; pass the new
env vars. **Docker socket mount stays read-only.** nginx proxy unchanged —
cookies flow same-origin in prod; Vite dev proxy already forwards cookies.

README: document the new env vars and a "generate a user entry" snippet
(`npm run hash-password`), update the security notes (console now requires
login; audit trail exists), keep the "don't expose beyond trusted network"
warning until TLS guidance exists.

New runtime dependencies (server only): `@fastify/secure-session`,
`@fastify/rate-limit`, `better-sqlite3` (+ `@types/better-sqlite3` dev).
No new web dependencies.

## Testing

Server-only Vitest, no Docker daemon, no real filesystem:

- scrypt hash/verify round-trip; rejects wrong password; constant-time compare
  used.
- `POST /api/login` success, wrong password, unknown user, malformed body,
  rate-limit kicks in after N failures.
- Gate: every protected route returns `401` without a cookie; `/api/health`
  and `/api/login` stay open; expired session (old `issuedAt`) rejected.
- Cookie round-trip via `app.inject()`: login → reuse cookie → `/api/me` and
  protected routes succeed; logout → subsequent requests `401`.
- Audit: all three auth events recorded with correct fields; `queryEvents`
  pagination, filters, newest-first ordering, `limit` cap; audit write failure
  doesn't fail the login (fail-open policy for this slice).
- `GET /api/audit` requires session, paginates, filters.

Existing 23 tests must keep passing (dockerode mock seam untouched). CI
workflow unchanged. Web tests remain a separate roadmap item.

## Out of scope (follow-ups)

- Mutating container endpoints + `rw` socket + fail-closed audit (Phase 2)
- Role enforcement (admin-only audit view, viewer read-only)
- Session revocation / server-side sessions
- Live log streaming over WebSockets
- Web-package tests
