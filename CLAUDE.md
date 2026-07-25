# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout

Two independent npm packages, no workspaces — run npm commands inside `server/` or `web/`, never at the root:

- `server/` — Fastify 5 + dockerode API (Node 22, ESM). All dockerode access goes through `src/docker.ts`; keep it the only module that touches dockerode (it's the mockable seam). Same pattern: `src/db.ts` is the only module that touches better-sqlite3 (connection + `user_version` migrations — append-only, never edit a shipped entry); `src/audit.ts` and `src/deployments.ts` own their tables through it. `src/auth.ts` is the only one that reads user config / verifies passwords.
- `web/` — React 18 + Vite SPA. Plain hooks — no router, no state library, no CSS framework.

## Commands (run inside each package)

- `npm run dev` — server: tsx watch on :4000; web: Vite on :5173 (dev server proxies `/api` to the server)
- `npm run typecheck` — typechecks each package (server typecheck includes `test/`)
- `npm run lint` — ESLint 9 flat config, type-checked rules (server: typescript-eslint; web: + react-hooks).
- `npm test` — Vitest in both packages: `server/test/` (no Docker daemon needed — dockerode is mocked) and `web/test/` (jsdom + React Testing Library; `fetch`/`WebSocket` stubbed at the boundary via `web/test/helpers.ts`, never module-mock `../src/api`). `npm run test:watch` for watch mode.
- CI (`.github/workflows/ci.yml`) runs typecheck + lint + tests + builds for both packages on pushes to `main` and PRs, then builds both container images — pushing them to GHCR (`ghcr.io/jvillama/fleet-console-{server,web}`, tags `sha-<7char>` + `latest`) only on `main`. `.github/workflows/deploy.yml` is a manual dispatch job that deploys a tag via the console API (needs FLEET_CONSOLE_URL/FLEET_DEPLOY_USER/FLEET_DEPLOY_PASSWORD secrets).
- Full stack: `docker compose up --build`, then open http://localhost:8080. Requires a running Docker daemon.
- `node scripts/smoke.mjs` — from the repo root, against a running stack: the only test covering the assembled product (nginx + server + WS). CI's `smoke` job runs it on every PR and gates image publishing.

## Gotchas

- Server uses NodeNext module resolution: relative imports must end in `.js` (e.g. `./docker.js`) even though sources are `.ts`. Web uses bundler resolution: extensionless imports.
- `web/src/types.ts` is GENERATED from `server/src/types.ts` (the API contract's single source of truth). Edit the server copy, then run `node scripts/sync-types.mjs` from the repo root; CI's `contract` job fails when the mirror is stale. Never hand-edit the web copy.
- Mutating routes live in `server/src/routes/actions.ts` and `server/src/routes/deployments.ts`: role-gate with `requireRole` (`operator` for actions, `admin` for deploy/rollback) and audit **fail-closed** via insert-then-update — copy that pattern for any new mutating endpoint. Deploys are async: the audit row settles when the pipeline finishes, not when the 202 goes out; deployment history and the single-flight guard key on container *name* (stable across recreates), not id.
- Per-container failures degrade to "—" in the UI instead of failing the whole response — preserve that pattern in server routes.
- Env vars come from the repo-root `.env` (gitignored, no .env.example): `docker compose` reads it, and `server`'s `dev`/`start` scripts load the same file via Node's `--env-file-if-exists=../.env`. Nothing in `src/` reads `.env` itself — `auth.ts` and `app.ts` only see `process.env`, so a server started without that flag has no users and dies with "No users configured". Values containing `#` must be quoted or both parsers truncate them to "". Tests never read `.env`; `test/setup.ts` seeds their env.
- Vars: server `PORT` (4000), `HOST`, `DOCKER_SOCKET`, `NODE_ENV`, `FLEET_SESSION_SECRET` (required, ≥32 chars), `FLEET_USERS`/`FLEET_USERS_FILE`, `AUDIT_DB_PATH` (default `./data/audit.db`), `FLEET_COOKIE_SECURE`; web `VITE_API_TARGET` (dev proxy target).
- All `/api/*` routes except `/api/health` and `/api/login` require a session — the `onRequest` gate in `app.ts` protects new routes by default. In tests, log in with `loginAs()` from `test/helpers.ts` and pass its result as `cookies:` to `app.inject`. Test env (secret, users, `:memory:` audit DB) is seeded by `test/setup.ts` via `vitest.config.ts`.
- Audit policy: reads and auth fail open (log + continue) when an audit write fails; mutating container actions fail closed (503, Docker untouched). Don't "fix" the fail-open behavior in auth routes.
- `GET /api/logs/:id` is a WebSocket route (`@fastify/websocket`); the session gate covers the upgrade request. In tests, drive it with `app.injectWS(path, { headers: { cookie: \`session=${cookies.session}\` } })` — see `test/logs-routes.test.ts`. Both proxies are WS-aware, so another WS route needs no proxy changes for the upgrade itself — but see the Host/Origin gotcha below before assuming the proxy layer is a solved problem.
- **The proxies must forward the browser's real `Host`, port included.** `logs.ts`'s `sameOrigin()` compares `new URL(origin).host` (which carries the port) against the `Host` header, so anything that rewrites Host breaks every upgrade with a 1008 `Origin not allowed` and an empty log panel. Two traps, both of which shipped and cost 11 days of dead log streaming: nginx's `$host` **drops the port** (use `$http_host` — `web/nginx.conf`), and Vite's `changeOrigin: true` **replaces Host with the target's** (keep `changeOrigin: false` — `web/vite.config.ts`). This only manifests on a non-default port, which is the compose default of `8080`. Fix the proxy, never the check — relaxing `sameOrigin()` to compare hostnames only would let any other service on the same host mount a cross-socket attack. `test/logs-routes.test.ts` pins all three port cases; a portless same-origin pair passes with or without the bug, which is exactly why it went unnoticed. `scripts/smoke.mjs` is the only automated check on this: its fourth assertion reads the first WebSocket frame's opcode, because a rejected stream still returns HTTP 101 and only then sends a 1008 close — so asserting the handshake succeeded proves nothing.
- CI runs npm 10 (Node 22), which rejects `package-lock.json` files written by npm 11+ (missing nested entries, platform packages recorded non-optional → `EBADPLATFORM`). After any dependency change, regenerate the lock with CI's npm and validate the same way: `rm -rf node_modules package-lock.json && npx -y npm@10.9.8 install && npx -y npm@10.9.8 ci`.
