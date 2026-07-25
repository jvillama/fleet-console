import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/docker.js", () => ({
  getContainerStats: vi.fn(),
  getFleetOverview: vi.fn(),
  listContainers: vi.fn(),
  pingDocker: vi.fn(),
  streamContainerLogs: vi.fn(),
  startContainer: vi.fn(),
  stopContainer: vi.fn(),
  restartContainer: vi.fn(),
  pullImage: vi.fn(),
  imageExistsLocally: vi.fn(),
  inspectForRecreate: vi.fn(),
  recreateContainer: vi.fn(),
  removeContainer: vi.fn(),
  watchHealth: vi.fn(),
  parkedContainerName: (name: string, deploymentId: number) =>
    `${name}-predeploy-${deploymentId}`,
}));

import * as dockerApi from "../src/docker.js";
import { buildApp } from "../src/app.js";
import { queryEvents } from "../src/audit.js";
import { closeDb } from "../src/db.js";
import { getDeployment } from "../src/deployments.js";
import { loginAs } from "./helpers.js";

const mocked = vi.mocked(dockerApi);

/** Budgets from ratelimit.ts — duplicated here on purpose, so a change to
 * the policy has to be a deliberate change to the test too. */
const ACTION_MAX = 20;
const DEPLOY_MAX = 6;

const STOP_URL = "/api/containers/abc123/stop";

let app: FastifyInstance;
let operator: { session: string };

beforeEach(async () => {
  vi.resetAllMocks();
  // A fresh app per test also resets the limiter's in-memory store.
  app = await buildApp();
  operator = await loginAs(app, "carol", "staple correct");
});

afterEach(async () => {
  await app.close();
});

function post(url: string, cookies: { session: string } = operator) {
  return app.inject({ method: "POST", url, cookies });
}

/** Drain a budget with sequential calls, asserting none were throttled. */
async function spend(n: number, url: string, cookies = operator): Promise<void> {
  for (let i = 0; i < n; i++) {
    const res = await post(url, cookies);
    expect(res.statusCode).not.toBe(429);
  }
}

function throttleRows(action: string) {
  return queryEvents({ limit: 200, offset: 0, action }).events.filter((e) =>
    e.detail?.includes("rate limit exceeded"),
  );
}

describe("container action limits", () => {
  beforeEach(() => {
    mocked.stopContainer.mockResolvedValue({ state: "exited", noOp: false });
  });

  it(`allows ${ACTION_MAX} calls per minute and throttles the next one`, async () => {
    for (let i = 0; i < ACTION_MAX; i++) {
      expect((await post(STOP_URL)).statusCode).toBe(200);
    }

    expect((await post(STOP_URL)).statusCode).toBe(429);
  });

  it("keys per user: one operator's burst leaves another's budget intact", async () => {
    const admin = await loginAs(app, "alice", "correct horse");
    await spend(ACTION_MAX, STOP_URL, admin);
    expect((await post(STOP_URL, admin)).statusCode).toBe(429);

    expect((await post(STOP_URL, operator)).statusCode).toBe(200);
  });

  it("returns an ApiError-shaped 429 with a retry hint and Retry-After", async () => {
    await spend(ACTION_MAX, STOP_URL);

    const res = await post(STOP_URL);

    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    const body = res.json<{ error: string; detail?: string }>();
    expect(body.error).toBe("Too Many Requests");
    expect(body.detail).toMatch(/retry in .+/);
    // The plugin's default body puts the useful text in `message`, which the
    // web's ApiError reader (detail ?? error) would drop.
    expect(body).not.toHaveProperty("message");
  });

  it("audits a throttle once per window, not once per blocked request", async () => {
    await spend(ACTION_MAX, STOP_URL);

    for (let i = 0; i < 5; i++) {
      expect((await post(STOP_URL)).statusCode).toBe(429);
    }

    const rows = throttleRows("container.stop");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "carol",
      role: "operator",
      target: "abc123",
      outcome: "failure",
    });
  });

  it("rejects sessionless requests at the gate without spending the budget", async () => {
    for (let i = 0; i < ACTION_MAX + 5; i++) {
      const res = await app.inject({ method: "POST", url: STOP_URL });
      expect(res.statusCode).toBe(401);
    }

    expect((await post(STOP_URL)).statusCode).toBe(200);
    expect(throttleRows("container.stop")).toHaveLength(0);
  });

  it("fails open: still 429 when the throttle's audit write fails", async () => {
    await spend(ACTION_MAX, STOP_URL);
    // Closing the store makes recordEvent throw on the throttle path.
    closeDb();

    const res = await post(STOP_URL);

    expect(res.statusCode).toBe(429);
  });
});

describe("deployment limits", () => {
  let admin: { session: string };

  beforeEach(async () => {
    admin = await loginAs(app, "alice", "correct horse");
  });

  function deploy(container: string) {
    return app.inject({
      method: "POST",
      url: `/api/containers/${container}/deploy`,
      payload: { tag: "1.28" },
      cookies: admin,
    });
  }

  it(`allows ${DEPLOY_MAX} deploys per minute and throttles the next one`, async () => {
    // Distinct container names so the per-container single-flight guard
    // never fires — this test is about the budget, nothing else.
    mocked.inspectForRecreate.mockImplementation((c: string) =>
      Promise.resolve({
        id: `${c}-id`,
        name: c,
        image: "nginx:1.27",
        wasRunning: true,
        createOptions: {},
        extraNetworks: [],
      }),
    );
    mocked.pullImage.mockResolvedValue(undefined);
    mocked.recreateContainer.mockResolvedValue("newid987");
    mocked.watchHealth.mockResolvedValue({ healthy: true });
    mocked.removeContainer.mockResolvedValue(undefined);

    const ids: number[] = [];
    for (let i = 0; i < DEPLOY_MAX; i++) {
      const res = await deploy(`web-${i}`);
      expect(res.statusCode).toBe(202);
      ids.push(res.json<{ deploymentId: number }>().deploymentId);
    }

    expect((await deploy("web-extra")).statusCode).toBe(429);
    // Let the detached pipelines settle so they cannot bleed into later tests.
    await vi.waitFor(() => {
      for (const id of ids) expect(getDeployment(id)?.status).toBe("succeeded");
    });
  });

  it(`allows ${DEPLOY_MAX} rollbacks per minute and throttles the next one`, async () => {
    // Unknown deployment id: 404 from the handler. Throttling runs before
    // the handler, so these still spend the budget — as intended.
    for (let i = 0; i < DEPLOY_MAX; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/deployments/999/rollback",
        cookies: admin,
      });
      expect(res.statusCode).toBe(404);
    }

    const res = await app.inject({
      method: "POST",
      url: "/api/deployments/999/rollback",
      cookies: admin,
    });
    expect(res.statusCode).toBe(429);
  });
});
