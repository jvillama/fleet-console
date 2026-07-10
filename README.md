# Fleet Console

An internal operations dashboard for a Docker container fleet. Treats the
containers on a host like machines in a small data center: one screen showing
what's up, what's down, and what each machine is consuming — refreshed live.

> **Status: Phase 1.5 (read-only visibility + auth & audit log).** See [Roadmap](#roadmap).

![screenshot placeholder — add a demo GIF here after first run]

## Why this exists

Operational questions like "is the fleet healthy?" and "what's eating memory?"
shouldn't require SSH-ing into a host and stringing together `docker ps` and
`docker stats` in a terminal. Fleet Console puts that state in a browser,
auto-refreshing, for anyone on the team — the same motivation as the internal
metrics tool I built at Hearful, applied to infrastructure instead of data
pipelines.

## Architecture

```
┌──────────────┐        ┌───────────────────┐        ┌────────────────┐
│   Browser    │  /api  │  web (nginx)      │  /api  │ server         │
│  React + TS  ├───────▶│  serves SPA,      ├───────▶│ Fastify + TS   │
│  polls 5s    │        │  proxies same-    │        │ dockerode      │
└──────────────┘        │  origin API       │        └───────┬────────┘
                        └───────────────────┘                │ unix socket
                                                             ▼ (read-only)
                                                    /var/run/docker.sock
```

- **`server/`** — Node 22 + Fastify + TypeScript (strict). A thin typed
  wrapper (`src/docker.ts`) is the only module that touches dockerode, so
  route handlers stay clean and the Docker layer can be mocked in tests.
- **`web/`** — React 18 + Vite + TypeScript (strict). A small `usePolling`
  hook refreshes fleet state every 5 s without flashing loading states, and
  pauses when the tab is hidden.
- **API contract** — plain TypeScript interfaces, mirrored between
  `server/src/types.ts` and `web/src/types.ts` (extracting these to a shared
  package or generating from OpenAPI is on the roadmap).

### Deliberate tradeoffs

| Decision | Why |
|---|---|
| Docker socket mounted **read-only** | Phase 1 only observes. Actions (Phase 2) will require `rw` — kept out until there's auth in front of it. |
| Polling, not WebSockets | For a fleet of dozens, a 5 s poll is simpler and plenty. Live log streaming in Phase 2 is where WebSockets actually earn their complexity. |
| nginx same-origin proxy in prod | No CORS surface in production; CORS is enabled only for local dev. |
| Stats fetched per-container, `Promise.allSettled` | One unhealthy container can't break the whole table — each row degrades to "—". |

## Running it

**Full stack in Docker (recommended first run):**

```bash
docker compose up --build
# open http://localhost:8080
```

The compose file includes two demo containers (`nginx`, `redis`) so the
dashboard isn't empty on first boot. Remove that section for real use.

**Local development (hot reload):**

```bash
# terminal 1 — API on :4000
cd server && npm install && npm run dev

# terminal 2 — UI on :5173, /api proxied to :4000
cd web && npm install && npm run dev
```

Requires a local Docker daemon (`/var/run/docker.sock`). Override with
`DOCKER_SOCKET=/path/to/sock`.

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
rows but not yet enforced — enforcement lands with Phase 2 actions. That
means any authenticated user, whatever their role, can currently read any
container's logs and the audit log.

Every login, failed login, logout, and log-stream open is recorded in a
SQLite audit log (compose persists it in the `audit-data` volume) and is
browsable from the **Audit log** tab in the UI. `GET /api/audit` serves it
with pagination and `actor`/`action` filters.

## API

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
| `WS /api/logs/:id` | session | Live container log stream (tail 200, then follow) |

## Roadmap

- [x] **Phase 1 — visibility:** container list, states, CPU/memory, overview strip
- [x] **Phase 1.5 — auth + audit:** named-user login, session cookie, SQLite audit log with UI viewer
- [x] **Phase 1.75 — live logs:** per-container log streaming over WebSockets, session-gated and audited
- [ ] **Phase 2 — actions:** start/stop/restart from the UI; socket mounted `rw`; role enforcement; mutating actions audited **fail-closed**
- [ ] **Phase 3 — deployment workflow:** pick an image tag, roll out to a container group, watch health, one-click rollback; CI/CD via GitHub Actions (lint → typecheck → build → push image → deploy)
- [ ] **Polish:** shared types package, web-package tests, README demo GIF

## Security notes

Mounting the Docker socket into a container is equivalent to root on the
host — that's why Phase 1 mounts it read-only and the app has no mutating
endpoints. The console now requires a named-user login (scrypt-hashed
passwords, encrypted HttpOnly session cookie, rate-limited login) and keeps
an audit log of auth events. Before Phase 2 lands, mutating endpoints must
enforce roles and fail closed when the audit write fails (see the design
spec). The stack still serves plain HTTP — put TLS in front (and set
`FLEET_COOKIE_SECURE=true`) before exposing port 8080 beyond a trusted
network. The server trusts `X-Forwarded-For` (`trustProxy`) because the
bundled nginx is the sole ingress — don't publish the server container's
port directly, or clients could spoof the rate-limit key and audit IPs.
