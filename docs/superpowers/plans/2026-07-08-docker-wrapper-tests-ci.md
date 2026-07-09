# Docker Wrapper Tests + CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Vitest test suite for the server's Docker wrapper and HTTP routes (no Docker daemon required), plus a GitHub Actions CI workflow running typecheck + tests + builds for both packages.

**Architecture:** Tests mock at module boundaries — `test/docker.test.ts` mocks the `dockerode` package to test the wrapper's transformation logic; `test/routes.test.ts` mocks `src/docker.js` and drives HTTP through Fastify's `inject()`. The only production change is extracting `buildApp()` from `index.ts` into a new `src/app.ts` so tests can construct the app without listening.

**Tech Stack:** Vitest (new dev dep in `server/` only), Fastify `inject()`, GitHub Actions with `actions/setup-node@v4` npm caching.

**Spec:** `docs/superpowers/specs/2026-07-08-docker-wrapper-tests-ci-design.md`

## Global Constraints

- Two independent npm packages — run npm commands inside `server/` or `web/`, never at the repo root.
- Server is ESM + NodeNext: relative imports must end in `.js` (e.g. `./docker.js`) even from `.ts` sources. This applies to test files too.
- `server/src/docker.ts` stays the only module that touches dockerode — and it must NOT be modified by this plan.
- Tests must pass with no Docker daemon running.
- Server tsconfig is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — test code must typecheck under these flags (`npm run typecheck` covers `test/` after Task 1).
- Commits on `main`, no `Co-Authored-By` trailer (user preference).

---

### Task 1: Vitest infrastructure + Docker wrapper tests

**Files:**
- Modify: `server/package.json` (scripts + devDependency via `npm install`)
- Modify: `server/tsconfig.json` (drop `rootDir`, include `test/`)
- Create: `server/tsconfig.build.json`
- Test: `server/test/docker.test.ts`

**Interfaces:**
- Consumes: existing exports of `server/src/docker.ts` — `listContainers(): Promise<ContainerSummary[]>`, `getContainerStats(id: string): Promise<ContainerStats>`, `getFleetOverview(): Promise<FleetOverview>`, `pingDocker(): Promise<boolean>`.
- Produces: working `npm test` / `npm run test:watch` scripts and a `server/test/` directory that later tasks add files to. `npm run build` now uses `tsconfig.build.json`.

- [ ] **Step 1: Install Vitest**

```bash
cd server && npm install --save-dev vitest
```

Expected: `vitest` appears in `server/package.json` devDependencies and lockfile updates.

- [ ] **Step 2: Add test scripts**

In `server/package.json`, change the `scripts` block to (build now points at the build tsconfig created in Step 3):

```json
"scripts": {
  "dev": "tsx watch src/index.ts",
  "build": "tsc -p tsconfig.build.json",
  "start": "node dist/index.js",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 3: Split tsconfig so typecheck sees tests but build ships only src**

Replace `server/tsconfig.json` with (only changes: `rootDir` removed, `include` gains `"test"`):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "sourceMap": true
  },
  "include": ["src", "test"]
}
```

Create `server/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Verify typecheck and build still pass before adding tests**

```bash
cd server && npm run typecheck && npm run build
```

Expected: both exit 0; `dist/` contains compiled `src` files only (no `test/`). Clean up: `rm -rf dist`.

- [ ] **Step 5: Write the wrapper tests**

Create `server/test/docker.test.ts`. The `vi.hoisted` block is required — `vi.mock` factories are hoisted above imports, so plain top-level variables would not be initialized when the factory runs.

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

// docker.ts creates its dockerode client at module load, so the mock must
// intercept the constructor before ../src/docker.js is imported.
const mockClient = vi.hoisted(() => ({
  listContainers: vi.fn(),
  getContainer: vi.fn(),
  version: vi.fn(),
  info: vi.fn(),
  ping: vi.fn(),
}));

vi.mock("dockerode", () => ({
  default: vi.fn(() => mockClient),
}));

import {
  getContainerStats,
  getFleetOverview,
  listContainers,
  pingDocker,
} from "../src/docker.js";

function rawContainer(overrides: Record<string, unknown> = {}) {
  return {
    Id: "abcdef1234567890",
    Names: ["/web-1"],
    Image: "nginx:1.27",
    State: "running",
    Status: "Up 2 hours",
    Created: 1751922000,
    Ports: [],
    ...overrides,
  };
}

function statsFixture(overrides: Record<string, unknown> = {}) {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: 400, percpu_usage: [0, 0] },
      system_cpu_usage: 2000,
      online_cpus: 2,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 200 },
      system_cpu_usage: 1000,
    },
    memory_stats: { usage: 104857600, limit: 419430400 },
    ...overrides,
  };
}

function mockStats(fixture: unknown): void {
  mockClient.getContainer.mockReturnValue({
    stats: vi.fn().mockResolvedValue(fixture),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listContainers", () => {
  it("maps raw container fields and strips the leading slash from names", async () => {
    mockClient.listContainers.mockResolvedValue([rawContainer()]);

    const [c] = await listContainers();

    expect(c).toEqual({
      id: "abcdef1234567890",
      shortId: "abcdef123456",
      name: "web-1",
      image: "nginx:1.27",
      state: "running",
      status: "Up 2 hours",
      createdAt: new Date(1751922000 * 1000).toISOString(),
      ports: [],
    });
    expect(mockClient.listContainers).toHaveBeenCalledWith({ all: true });
  });

  it("falls back to the short id when the container has no names", async () => {
    mockClient.listContainers.mockResolvedValue([rawContainer({ Names: [] })]);

    const [c] = await listContainers();

    expect(c!.name).toBe("abcdef123456");
  });

  it("maps unknown states to dead", async () => {
    mockClient.listContainers.mockResolvedValue([
      rawContainer({ State: "glitched" }),
    ]);

    const [c] = await listContainers();

    expect(c!.state).toBe("dead");
  });

  it("maps ports, dropping unexposed entries and absent host ports", async () => {
    mockClient.listContainers.mockResolvedValue([
      rawContainer({
        Ports: [
          { PrivatePort: 80, PublicPort: 8080, Type: "tcp" },
          { PrivatePort: 53, Type: "udp" },
          { Type: "tcp" },
        ],
      }),
    ]);

    const [c] = await listContainers();

    expect(c!.ports).toEqual([
      { containerPort: 80, protocol: "tcp", hostPort: 8080 },
      { containerPort: 53, protocol: "udp" },
    ]);
  });
});

describe("getContainerStats", () => {
  it("computes CPU and memory percentages from a stats sample", async () => {
    mockStats(statsFixture());

    const s = await getContainerStats("abc123");

    // cpuDelta 200, systemDelta 1000, 2 CPUs → 40%
    expect(s.cpuPercent).toBe(40);
    expect(s.memoryUsageBytes).toBe(104857600);
    expect(s.memoryLimitBytes).toBe(419430400);
    expect(s.memoryPercent).toBe(25);
    expect(s.id).toBe("abc123");
    expect(mockClient.getContainer).toHaveBeenCalledWith("abc123");
  });

  it("rounds cpuPercent to one decimal place", async () => {
    mockStats(
      statsFixture({
        cpu_stats: {
          cpu_usage: { total_usage: 400 },
          system_cpu_usage: 2200,
          online_cpus: 1,
        },
      }),
    );

    const s = await getContainerStats("abc123");

    // cpuDelta 200, systemDelta 1200, 1 CPU → 16.666… → 16.7
    expect(s.cpuPercent).toBe(16.7);
  });

  it("returns 0 cpuPercent when there is no delta", async () => {
    mockStats(
      statsFixture({
        cpu_stats: {
          cpu_usage: { total_usage: 200 },
          system_cpu_usage: 1000,
          online_cpus: 2,
        },
      }),
    );

    const s = await getContainerStats("abc123");

    expect(s.cpuPercent).toBe(0);
  });

  it("falls back to percpu_usage length when online_cpus is missing", async () => {
    mockStats(
      statsFixture({
        cpu_stats: {
          cpu_usage: { total_usage: 400, percpu_usage: [0, 0, 0, 0] },
          system_cpu_usage: 2000,
        },
      }),
    );

    const s = await getContainerStats("abc123");

    // cpuDelta 200, systemDelta 1000, 4 CPUs → 80%
    expect(s.cpuPercent).toBe(80);
  });

  it("falls back to 1 CPU when no CPU topology is reported", async () => {
    mockStats(
      statsFixture({
        cpu_stats: {
          cpu_usage: { total_usage: 400 },
          system_cpu_usage: 2000,
        },
      }),
    );

    const s = await getContainerStats("abc123");

    // cpuDelta 200, systemDelta 1000, 1 CPU → 20%
    expect(s.cpuPercent).toBe(20);
  });

  it("degrades memory fields to 0 when memory stats are missing", async () => {
    mockStats(statsFixture({ memory_stats: {} }));

    const s = await getContainerStats("abc123");

    expect(s.memoryUsageBytes).toBe(0);
    expect(s.memoryLimitBytes).toBe(0);
    expect(s.memoryPercent).toBe(0);
  });
});

describe("getFleetOverview", () => {
  it("counts running and stopped containers", async () => {
    mockClient.listContainers.mockResolvedValue([
      rawContainer({ State: "running" }),
      rawContainer({ State: "exited" }),
      rawContainer({ State: "paused" }),
    ]);
    mockClient.version.mockResolvedValue({ Version: "27.1.1" });
    mockClient.info.mockResolvedValue({ Name: "docker-host" });

    expect(await getFleetOverview()).toEqual({
      total: 3,
      running: 1,
      stopped: 2,
      dockerVersion: "27.1.1",
      hostName: "docker-host",
    });
  });

  it("reports unknown when the daemon has no name", async () => {
    mockClient.listContainers.mockResolvedValue([]);
    mockClient.version.mockResolvedValue({ Version: "27.1.1" });
    mockClient.info.mockResolvedValue({});

    expect((await getFleetOverview()).hostName).toBe("unknown");
  });
});

describe("pingDocker", () => {
  it("returns true when the socket responds", async () => {
    mockClient.ping.mockResolvedValue("OK");

    expect(await pingDocker()).toBe(true);
  });

  it("returns false when the socket is unreachable", async () => {
    mockClient.ping.mockRejectedValue(new Error("connect ENOENT"));

    expect(await pingDocker()).toBe(false);
  });
});
```

- [ ] **Step 6: Run the tests**

```bash
cd server && npm test
```

Expected: PASS — 12 tests. These are characterization tests of existing working code, so they should pass immediately; a failure means either the test fixture or the mock wiring is wrong (fix the test, not `docker.ts`).

- [ ] **Step 7: Typecheck including the new test file**

```bash
cd server && npm run typecheck
```

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add server/package.json server/package-lock.json server/tsconfig.json server/tsconfig.build.json server/test/docker.test.ts
git commit -m "test: add Vitest and Docker wrapper unit tests"
```

---

### Task 2: Extract buildApp() and add route tests (TDD)

**Files:**
- Create: `server/src/app.ts`
- Modify: `server/src/index.ts` (full rewrite, shown below)
- Test: `server/test/routes.test.ts`

**Interfaces:**
- Consumes: `containerRoutes(app: FastifyInstance): Promise<void>` from `src/routes/containers.js`; `pingDocker(): Promise<boolean>` from `src/docker.js`; `npm test` from Task 1.
- Produces: `buildApp(opts?: { logger?: FastifyServerOptions["logger"] }): Promise<FastifyInstance>` exported from `src/app.ts` — the app fully wired (CORS, `/api/health`, container routes) but not listening.

- [ ] **Step 1: Write the failing route tests**

Create `server/test/routes.test.ts`:

```typescript
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

const mocked = vi.mocked(dockerApi);

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
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

    const res = await app.inject({ url: "/api/containers" });

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

    const res = await app.inject({ url: "/api/overview" });

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

    const res = await app.inject({ url: "/api/containers/abc123/stats" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(stats);
  });

  it("rejects ids with unexpected characters before touching Docker", async () => {
    const res = await app.inject({ url: "/api/containers/bad$id/stats" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid container id" });
    expect(mocked.getContainerStats).not.toHaveBeenCalled();
  });

  it("maps Docker 404s to a 404 response", async () => {
    mocked.getContainerStats.mockRejectedValue(
      Object.assign(new Error("no such container"), { statusCode: 404 }),
    );

    const res = await app.inject({ url: "/api/containers/deadbeef/stats" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: "Container not found",
      detail: "no such container",
    });
  });

  it("maps other Docker failures to a 502 response", async () => {
    mocked.getContainerStats.mockRejectedValue(new Error("socket hang up"));

    const res = await app.inject({ url: "/api/containers/abc123/stats" });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: "Stats unavailable",
      detail: "socket hang up",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail for the right reason**

```bash
cd server && npm test
```

Expected: `docker.test.ts` still passes; `routes.test.ts` FAILS with a module-resolution error — `Cannot find module '../src/app.js'` (or similar) — because `src/app.ts` does not exist yet.

- [ ] **Step 3: Create src/app.ts**

```typescript
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import cors from "@fastify/cors";
import { containerRoutes } from "./routes/containers.js";
import { pingDocker } from "./docker.js";

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
  const app = Fastify({ logger: opts.logger ?? false });

  // In production the frontend is served from the same origin (or behind
  // the same reverse proxy), so CORS is only open for local dev.
  await app.register(cors, {
    origin: process.env.NODE_ENV === "production" ? false : true,
  });

  app.get("/api/health", async () => {
    const dockerReachable = await pingDocker();
    return {
      ok: dockerReachable,
      docker: dockerReachable ? "connected" : "unreachable",
      uptimeSeconds: Math.round(process.uptime()),
    };
  });

  await app.register(containerRoutes);

  return app;
}
```

- [ ] **Step 4: Slim index.ts down to env + listen**

Replace `server/src/index.ts` entirely with:

```typescript
import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
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

- [ ] **Step 5: Run tests and typecheck**

```bash
cd server && npm test && npm run typecheck
```

Expected: PASS — 20 tests (12 wrapper + 8 route), typecheck exit 0.

- [ ] **Step 6: Smoke-check the dev server still boots**

```bash
cd server && timeout 10 npm run dev; true
```

Expected: within the 10s window, log shows `Server listening at http://0.0.0.0:4000` (Docker-unreachable warnings are fine if no daemon is running; the process is killed by the timeout — that's expected).

- [ ] **Step 7: Commit**

```bash
git add server/src/app.ts server/src/index.ts server/test/routes.test.ts
git commit -m "test: extract buildApp() and add HTTP route tests"
```

---

### Task 3: GitHub Actions CI + docs update

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `CLAUDE.md` (commands section — the "no test suite" line is now stale)

**Interfaces:**
- Consumes: `npm run typecheck` / `npm test` / `npm run build` in `server/`; `npm run typecheck` / `npm run build` in `web/` (all exist after Tasks 1–2).
- Produces: CI status checks named `server` and `web` on pushes to `main` and all PRs.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  server:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: server
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: server/package-lock.json
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build

  web:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: web
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: web/package-lock.json
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
```

- [ ] **Step 2: Update CLAUDE.md commands section**

In `CLAUDE.md`, replace the line:

```markdown
- `npm run typecheck` — the only automated check; there is no linter or test suite yet
```

with:

```markdown
- `npm run typecheck` — typechecks each package (server typecheck includes `test/`)
- `npm test` — server only: Vitest suite in `server/test/`, no Docker daemon needed (dockerode is mocked). `npm run test:watch` for watch mode. No linter yet.
- CI (`.github/workflows/ci.yml`) runs typecheck + tests + builds for both packages on pushes to `main` and PRs.
```

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/ci.yml CLAUDE.md
git commit -m "ci: add GitHub Actions workflow (typecheck, tests, builds)"
git push origin main
```

- [ ] **Step 4: Verify CI goes green**

```bash
gh run watch --exit-status
```

(If prompted to select a run, use `gh run list --limit 1` to get the run id first.)
Expected: both `server` and `web` jobs succeed. If a job fails, read the log with `gh run view --log-failed`, fix, commit, push, and re-verify.
