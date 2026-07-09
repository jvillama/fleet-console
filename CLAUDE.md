# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout

Two independent npm packages, no workspaces — run npm commands inside `server/` or `web/`, never at the root:

- `server/` — Fastify 5 + dockerode API (Node 22, ESM). All dockerode access goes through `src/docker.ts`; keep it the only module that touches dockerode (it's the mockable seam).
- `web/` — React 18 + Vite SPA. Plain hooks — no router, no state library, no CSS framework.

## Commands (run inside each package)

- `npm run dev` — server: tsx watch on :4000; web: Vite on :5173 (dev server proxies `/api` to the server)
- `npm run typecheck` — typechecks each package (server typecheck includes `test/`)
- `npm test` — server only: Vitest suite in `server/test/`, no Docker daemon needed (dockerode is mocked). `npm run test:watch` for watch mode. No linter yet.
- CI (`.github/workflows/ci.yml`) runs typecheck + tests + builds for both packages on pushes to `main` and PRs.
- Full stack: `docker compose up --build`, then open http://localhost:8080. Requires a running Docker daemon.

## Gotchas

- Server uses NodeNext module resolution: relative imports must end in `.js` (e.g. `./docker.js`) even though sources are `.ts`. Web uses bundler resolution: extensionless imports.
- `server/src/types.ts` and `web/src/types.ts` are hand-mirrored API contract types — any change to one must be copied to the other.
- The compose file mounts the Docker socket read-only; Phase 1 is observe-only. Don't add mutating Docker endpoints without revisiting that mount and auth.
- Per-container failures degrade to "—" in the UI instead of failing the whole response — preserve that pattern in server routes.
- Env vars (no .env.example): server `PORT` (4000), `HOST`, `DOCKER_SOCKET`, `NODE_ENV`; web `VITE_API_TARGET` (dev proxy target).
