# Fleet Console

An internal operations dashboard for a Docker container fleet. Treats the
containers on a host like machines in a small data center: one screen showing
what's up, what's down, and what each machine is consuming — refreshed live.

> **Status: Phase 1 (read-only visibility).** See [Roadmap](#roadmap).

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

## API

| Route | Returns |
|---|---|
| `GET /api/health` | Server + Docker socket reachability |
| `GET /api/overview` | Fleet counts, Docker version, hostname |
| `GET /api/containers` | All containers (including stopped) |
| `GET /api/containers/:id/stats` | One-shot CPU/memory sample |

## Roadmap

- [x] **Phase 1 — visibility:** container list, states, CPU/memory, overview strip
- [ ] **Phase 2 — actions:** start/stop/restart from the UI; live log streaming over WebSockets; socket mounted `rw` behind auth
- [ ] **Phase 3 — deployment workflow:** pick an image tag, roll out to a container group, watch health, one-click rollback; CI/CD via GitHub Actions (lint → typecheck → build → push image → deploy)
- [ ] **Polish:** auth, audit log of operator actions, shared types package, tests for the Docker wrapper

## Security notes

Mounting the Docker socket into a container is equivalent to root on the
host — that's why Phase 1 mounts it read-only and the app has no mutating
endpoints. Before Phase 2 lands, the console needs authentication and an
audit log. Don't expose port 8080 beyond a trusted network in the meantime.
