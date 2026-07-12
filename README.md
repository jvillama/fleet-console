# Fleet Console

An internal operations dashboard for a Docker container fleet. Treats the
containers on a host like machines in a small data center: one screen showing
what's up, what's down, and what each machine is consuming — refreshed live.

> **Status: Phase 3 (deployment workflow: deploy an image tag, watch health, one-click rollback).** See [Roadmap](#roadmap).

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
                                                             ▼ (read-write)
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
| Docker socket mounted **read-write** | Phase 2 actions need it. Mitigations: session + role gate on every mutating route, fail-closed audit, nginx as sole ingress. The console can stop itself — documented, not guarded. |
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
| `POST /api/containers/:id/start` | session + operator | Start a container |
| `POST /api/containers/:id/stop` | session + operator | Stop a container (10s grace) |
| `POST /api/containers/:id/restart` | session + operator | Restart a container |
| `POST /api/containers/:id/deploy` | session + admin | Deploy a new image tag (async — returns `202 { deploymentId }`) |
| `POST /api/deployments/:id/rollback` | session + admin | Roll back to that deployment's previous image |
| `GET /api/deployments/:id` | session | One deployment's status |
| `GET /api/deployments?container=` | session | Deployment history for a container name |

## Roadmap

- [x] **Phase 1 — visibility:** container list, states, CPU/memory, overview strip
- [x] **Phase 1.5 — auth + audit:** named-user login, session cookie, SQLite audit log with UI viewer
- [x] **Phase 1.75 — live logs:** per-container log streaming over WebSockets, session-gated and audited
- [x] **Phase 2 — actions:** start/stop/restart from the UI; socket mounted `rw`; role enforcement; mutating actions audited **fail-closed**
- [x] **Phase 3 — deployment workflow:** pick an image tag, deploy per container with health watch and one-click rollback; deploys admin-only, audited fail-closed
- [ ] **Phase 3.5 — CI/CD:** GitHub Actions build → push image → deploy against the console
- [ ] **Polish:** shared types package, web-package tests, README demo GIF

## Security notes

Mounting the Docker socket into a container is equivalent to root on the
host. Phase 1 mounted it read-only; Phase 2 (container actions) mounts it
read-write, so the console itself is now a high-value target. Mitigations:
every mutating route requires an operator or admin session (viewers are
read-only), and every action attempt is audited **fail-closed** — if the
audit write fails, the action is refused with a 503. One deliberate
footgun: the console can stop its own containers from its own dashboard,
exactly as `docker stop` could; there is no self-protection guard, so
operators should treat the fleet-console rows with the same care as a
terminal. The stack still serves plain HTTP — put TLS in front (and set
`FLEET_COOKIE_SECURE=true`) before exposing port 8080 beyond a trusted
network. The server trusts `X-Forwarded-For` (`trustProxy`) because the
bundled nginx is the sole ingress — don't publish the server container's
port directly, or clients could spoof the rate-limit key and audit IPs.

Deploys raise the stakes again: they change what code runs, so they require
the **admin** role (operators keep start/stop/restart) and follow the same
fail-closed audit pattern with the outcome settled when the pipeline
finishes. Three sharp edges are documented rather than solved: recreating a
compose-managed container makes `docker compose` see it as drifted (the next
`up` may recreate it); deploying fleet-console's own containers can kill the
console mid-deploy (same no-self-guard policy as Phase 2); and data in
anonymous volumes not listed in `HostConfig.Binds` does not survive the
recreate — use named volumes for anything you care about.
