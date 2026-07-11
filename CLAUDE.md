# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout

Two independent npm packages, no workspaces — run npm commands inside `server/` or `web/`, never at the root:

- `server/` — Fastify 5 + dockerode API (Node 22, ESM). All dockerode access goes through `src/docker.ts`; keep it the only module that touches dockerode (it's the mockable seam). Same pattern: `src/audit.ts` is the only module that touches better-sqlite3, and `src/auth.ts` the only one that reads user config / verifies passwords.
- `web/` — React 18 + Vite SPA. Plain hooks — no router, no state library, no CSS framework.

## Commands (run inside each package)

- `npm run dev` — server: tsx watch on :4000; web: Vite on :5173 (dev server proxies `/api` to the server)
- `npm run typecheck` — typechecks each package (server typecheck includes `test/`)
- `npm test` — Vitest in both packages: `server/test/` (no Docker daemon needed — dockerode is mocked) and `web/test/` (jsdom + React Testing Library; `fetch`/`WebSocket` stubbed at the boundary via `web/test/helpers.ts`, never module-mock `../src/api`). `npm run test:watch` for watch mode. No linter yet.
- CI (`.github/workflows/ci.yml`) runs typecheck + tests + builds for both packages on pushes to `main` and PRs.
- Full stack: `docker compose up --build`, then open http://localhost:8080. Requires a running Docker daemon.

## Gotchas

- Server uses NodeNext module resolution: relative imports must end in `.js` (e.g. `./docker.js`) even though sources are `.ts`. Web uses bundler resolution: extensionless imports.
- `server/src/types.ts` and `web/src/types.ts` are hand-mirrored API contract types — any change to one must be copied to the other.
- The compose file mounts the Docker socket read-write (Phase 2). Mutating routes live in `server/src/routes/actions.ts`: role-gate with `requireRole` from `src/authz.ts` and audit **fail-closed** via insert-then-update (`recordEvent` → act → `updateEventOutcome`) — copy that pattern for any new mutating endpoint.
- Per-container failures degrade to "—" in the UI instead of failing the whole response — preserve that pattern in server routes.
- Env vars (no .env.example): server `PORT` (4000), `HOST`, `DOCKER_SOCKET`, `NODE_ENV`, `FLEET_SESSION_SECRET` (required, ≥32 chars), `FLEET_USERS`/`FLEET_USERS_FILE`, `AUDIT_DB_PATH` (default `./data/audit.db`), `FLEET_COOKIE_SECURE`; web `VITE_API_TARGET` (dev proxy target).
- All `/api/*` routes except `/api/health` and `/api/login` require a session — the `onRequest` gate in `app.ts` protects new routes by default. In tests, log in with `loginAs()` from `test/helpers.ts` and pass its result as `cookies:` to `app.inject`. Test env (secret, users, `:memory:` audit DB) is seeded by `test/setup.ts` via `vitest.config.ts`.
- Audit policy: reads and auth fail open (log + continue) when an audit write fails; mutating container actions fail closed (503, Docker untouched). Don't "fix" the fail-open behavior in auth routes.
- `GET /api/logs/:id` is a WebSocket route (`@fastify/websocket`); the session gate covers the upgrade request. In tests, drive it with `app.injectWS(path, { headers: { cookie: \`session=${cookies.session}\` } })` — see `test/logs-routes.test.ts`. The nginx and Vite proxies are WS-aware; if you add another WS route, no proxy changes are needed.
- CI runs npm 10 (Node 22), which rejects `package-lock.json` files written by npm 11+ (missing nested entries, platform packages recorded non-optional → `EBADPLATFORM`). After any dependency change, regenerate the lock with CI's npm and validate the same way: `rm -rf node_modules package-lock.json && npx -y npm@10.9.8 install && npx -y npm@10.9.8 ci`.
