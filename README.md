# Fleet Console

An internal operations dashboard for a Docker container fleet. Treats the
containers on a host like machines in a small data center: one screen showing
what's up, what's down, and what each machine is consuming — refreshed live.

> **Status: all planned phases complete (visibility → auth → logs → actions → deployments → CI/CD).** Remaining polish: README demo GIF. See [Roadmap](#roadmap).

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
- **API contract** — plain TypeScript interfaces. `server/src/types.ts` is
  the single source of truth; `web/src/types.ts` is generated from it by
  `node scripts/sync-types.mjs`, and CI fails any PR where the mirror is
  stale.

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

**2. Configure users and a session secret.** Put them in a `.env` file next
to `docker-compose.yml`:

```bash
FLEET_SESSION_SECRET="<any random string, 32+ characters>"
FLEET_USERS=[{"username":"alice","role":"admin","passwordHash":"scrypt:…"}]
```

`docker compose` reads that file, and so do `npm run dev` / `npm start` in
`server/` (via Node's `--env-file-if-exists=../.env`) — one file for both
ways of running the stack. Quote any value containing `#`: both parsers
otherwise treat it as the start of a comment and hand you an empty string.

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

Mutating routes are rate-limited **per user** (the session username, not the
IP, so operators behind one NAT don't starve each other): 20/minute for
start/stop/restart, 6/minute each for deploy and rollback, and 5/minute per
IP for login. Over budget returns `429` with a `Retry-After` header and the
usual `{error, detail}` body; the first throttle in a window is audited.
Reads are unlimited.

Log streams are lossy under backpressure rather than unbounded: if a client
falls far enough behind that its send queue passes 1 MiB, the server drops
lines until the queue drains, then emits a `⚠ N lines dropped (slow
client)` line in the stream. The panel keeps the last 2000 lines anyway.

One user may hold at most **5 log streams open at once**. A further open is
closed immediately with code `1013` and a reason naming the cap, and the
rejection is audited. Together with the per-stream 1 MiB ceiling above, that
bounds what one user's log streams can hold in queued log frames at 5 MiB —
a slot stranded by a client that vanishes without closing cleanly still
clears on its own within an hour, via the bundled proxy's read timeout.

## Roadmap

- [x] **Phase 1 — visibility:** container list, states, CPU/memory, overview strip
- [x] **Phase 1.5 — auth + audit:** named-user login, session cookie, SQLite audit log with UI viewer
- [x] **Phase 1.75 — live logs:** per-container log streaming over WebSockets, session-gated and audited
- [x] **Phase 2 — actions:** start/stop/restart from the UI; socket mounted `rw`; role enforcement; mutating actions audited **fail-closed**
- [x] **Phase 3 — deployment workflow:** pick an image tag, deploy per container with health watch and one-click rollback; deploys admin-only, audited fail-closed
- [x] **Phase 3.5 — CI/CD:** GitHub Actions build → push image → deploy against the console
- [x] **Polish — contract & tests:** single-source API types (generated mirror, CI-enforced); web package test suite
- [ ] **Polish:** README demo GIF

## CI/CD

Every push to `main` runs the full pipeline — typecheck → lint → test →
build in both packages — then builds and publishes both container images
to GHCR: `ghcr.io/jvillama/fleet-console-server` and
`ghcr.io/jvillama/fleet-console-web`, each tagged `sha-<7char>` (the exact
commit) and `latest`. Pull requests run the same pipeline and build the
images without pushing, so a broken Dockerfile fails the PR.

Consuming the images: `docker compose pull && docker compose up -d`
fetches `latest` (the compose file still builds locally with
`up --build`, so the offline dev loop is unchanged) — or roll a single
container between `sha-*` tags from fleet-console's own deploy UI, which
is the dogfood path. GHCR packages are **private by default**, so pulls
fail with `unauthorized` until you either flip both packages to public in
the GitHub UI or `docker login ghcr.io` with a classic PAT that has the
`read:packages` scope.

A manual **Deploy** workflow (`Actions → Deploy → Run workflow`) calls the
console's deploy API for a chosen container and tag. It needs three repo
secrets — `FLEET_CONSOLE_URL`, `FLEET_DEPLOY_USER`, `FLEET_DEPLOY_PASSWORD`
(an admin account created for CI) — and fails with instructions when they
are unset. Two caveats: point it only at an HTTPS console
(`FLEET_COOKIE_SECURE=true` behind TLS), and deploying the console's own
`server` container drops the workflow's status poll mid-flight (the
self-deploy footgun) — the run may report a timeout even though the deploy
succeeded.

### Smoke tests

`server/` and `web/` are unit-tested in isolation, which leaves the
assembled product — nginx's SPA fallback, `/api` forwarding, session-cookie
passthrough, and the WebSocket upgrade — untested. `scripts/smoke.mjs`
covers that seam against a running stack:

```bash
docker compose --env-file .env.smoke up -d --build
node scripts/smoke.mjs
docker compose --env-file .env.smoke down -v
```

Never `cp .env.smoke .env` — `.env` is gitignored and holds your real
credentials, and copying over it is unrecoverable. `--env-file` replaces
`.env` for compose's variable interpolation without touching the file, but
every subsequent `docker compose` invocation against this stack needs the
same flag (interpolation otherwise fails), which is why the `down` line
above carries it too.

It checks that the SPA is served, that login sets a session cookie through
the proxy, that the API lists the demo fleet, and that the log stream
delivers a real text frame rather than an immediate close. Override
`SMOKE_BASE_URL`, `SMOKE_USER`, and `SMOKE_PASSWORD` to point it at another
stack. Login is rate-limited to 5/minute per IP (see API table below), so
running the script more than five times in a minute fails check 2 with a
429 — space out repeated runs. CI runs this on every PR and blocks image
publishing on it; blocking *merges* on a red smoke job additionally
requires `smoke` to be added to this repository's branch-protection
required status checks, which is a GitHub setting, not something any file
here configures.

## Security notes

Mounting the Docker socket into a container is equivalent to root on the
host. Phase 1 mounted it read-only; Phase 2 (container actions) mounts it
read-write, so the console itself is now a high-value target. Mitigations:
every mutating route requires an operator or admin session (viewers are
read-only), every action attempt is audited **fail-closed** — if the
audit write fails, the action is refused with a 503 — and every mutating
route carries a per-user rate limit, so a stolen session cookie can't drive
unbounded container churn. One deliberate
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
recreate — use named volumes for anything you care about. A failed image
pull falls back to a locally present copy of the tag, so rollback keeps
working when the registry is unreachable. Note that deploying a stopped
container starts it: the recreated container is always started so the
health watch can judge it.
