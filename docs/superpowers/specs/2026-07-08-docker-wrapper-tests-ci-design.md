# Design: Docker wrapper tests + CI

**Date:** 2026-07-08
**Status:** Approved
**Scope:** Server-side unit/route tests and a GitHub Actions pipeline. No web-package tests in this pass.

## Goal

Give fleet-console its first automated test suite — covering `server/src/docker.ts`
(the dockerode wrapper seam) and the HTTP routes — and a CI workflow that runs
typecheck, tests, and builds on every push and PR. This is the stated
prerequisite work before Phase 2 adds mutating Docker endpoints.

Success criteria:

- `npm test` passes in `server/` with **no Docker daemon required** (all Docker
  access is mocked).
- `npm run typecheck` stays green in both packages and now covers test files.
- CI is green on GitHub for the change that introduces this.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Test framework | Vitest | Runs TS/ESM (NodeNext) natively; same runner usable in `web/` later; strong mocking without refactoring working Phase 1 code. |
| Mocking strategy | Module mocks (`vi.mock`) | Wrapper tests mock `dockerode`; route tests mock `../src/docker.js`. No DI refactor of `docker.ts`. |
| Route testing | Fastify `app.inject()` | HTTP-level assertions without binding a port. |
| CI scope | Typecheck + tests + package builds | Catches build breakage; skips Docker image builds (slow, not needed — tests are fully mocked). |

Alternatives considered and rejected for now:

- **DI refactor of `docker.ts`** (factory taking a Docker client): cleaner seams
  but a larger change to working Phase 1 code; revisit in Phase 2 if module
  mocks get awkward.
- **`node:test` built-in runner**: zero new deps, but ESM module mocking is
  still experimental, which would force the DI refactor anyway.

## Production code changes (test-enabling only)

1. **New `server/src/app.ts`** exporting `buildApp(opts?: { logger?: boolean })`:
   moves Fastify instantiation, CORS registration, the `/api/health` route, and
   `containerRoutes` registration out of `index.ts`'s `main()`. Tests pass
   `{ logger: false }`.
2. **`server/src/index.ts`** shrinks to: read `PORT`/`HOST` env, `buildApp()`,
   `listen()`, fatal-error handler. Behavior unchanged.
3. **`server/src/docker.ts`**: no changes.

## Test layout and config

- Tests live in `server/test/` (outside `src/`, so they never compile into `dist/`):
  - `server/test/docker.test.ts`
  - `server/test/routes.test.ts`
- `server/tsconfig.json` `include` becomes `["src", "test"]` so `typecheck`
  covers tests. New `server/tsconfig.build.json` extends it with
  `include: ["src"]`; the `build` script points at it.
- `server/package.json`: add dev dependency `vitest`; scripts
  `"test": "vitest run"` and `"test:watch": "vitest"`.

## Test coverage

### `docker.test.ts` — mocks the `dockerode` module (fake client behind the constructor)

- `listContainers`
  - strips leading `/` from names; falls back to 12-char short id when `Names` is empty
  - maps known states through; unknown state string → `"dead"`
  - port mapping: tcp and udp, drops entries without `PrivatePort`, omits
    `hostPort` when unpublished
  - converts epoch seconds `Created` to ISO `createdAt`
- `getContainerStats`
  - CPU percent from cpu/system deltas × online CPUs × 100, rounded to 1 decimal
  - zero or negative deltas → `0`
  - `online_cpus` missing → falls back to `percpu_usage.length`, then `1`
  - missing `memory_stats.usage`/`limit` → `0`; `memoryPercent` is `0` when limit is `0`
- `getFleetOverview`
  - running/stopped counts from container states; total matches
  - `info.Name` missing → `hostName: "unknown"`
- `pingDocker`
  - resolves → `true`; rejects → `false`

### `routes.test.ts` — mocks `../src/docker.js`, drives requests via `buildApp().inject()`

- `GET /api/health` — `{ ok: true, docker: "connected" }` when ping succeeds;
  `{ ok: false, docker: "unreachable" }` when it fails
- `GET /api/containers` and `GET /api/overview` — 200 with wrapper data passed through
- `GET /api/containers/:id/stats`
  - id with characters outside `[a-zA-Z0-9._-]` → 400 `{ error: "Invalid container id" }`
  - wrapper throws error with `statusCode: 404` → 404 `{ error: "Container not found" }`
  - wrapper throws any other error → 502 `{ error: "Stats unavailable" }` with `detail`

## CI workflow — `.github/workflows/ci.yml`

- **Triggers:** push to `main`, and all pull requests.
- **Jobs (parallel):** both on `ubuntu-latest`, Node 22 via `actions/setup-node`
  with npm caching keyed per package lockfile.
  - `server`: `npm ci` → `npm run typecheck` → `npm test` → `npm run build`
  - `web`: `npm ci` → `npm run typecheck` → `npm run build`
- No Docker daemon or image builds in CI.

## Out of scope

- Web-package tests (usePolling hook etc.) — follow-up.
- Docker image builds in CI — revisit alongside the Phase 3 CI/CD roadmap item.
- Auth — separate prerequisite for Phase 2, unaffected by this work.
