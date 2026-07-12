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
}));

import * as dockerApi from "../src/docker.js";
import { buildApp } from "../src/app.js";
import { queryEvents } from "../src/audit.js";
import { closeDb } from "../src/db.js";
import { loginAs } from "./helpers.js";

const mocked = vi.mocked(dockerApi);

let app: FastifyInstance;
let cookies: { session: string };

beforeEach(async () => {
  vi.resetAllMocks();
  app = await buildApp();
  cookies = await loginAs(app, "carol", "staple correct"); // operator
});

afterEach(async () => {
  await app.close();
});

function post(url: string, sessionCookies: { session: string } = cookies) {
  return app.inject({ method: "POST", url, cookies: sessionCookies });
}

function auditRows(action: string) {
  return queryEvents({ limit: 10, offset: 0, action }).events;
}

describe.each([
  ["start", () => mocked.startContainer, "running"],
  ["stop", () => mocked.stopContainer, "exited"],
  ["restart", () => mocked.restartContainer, "running"],
] as const)("POST /api/containers/:id/%s", (action, getMock, endState) => {
  it("runs the action and audits success with actor, target, and ip", async () => {
    getMock().mockResolvedValue({ state: endState, noOp: false });

    const res = await post(`/api/containers/abc123/${action}`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "abc123", action, state: endState });
    expect(getMock()).toHaveBeenCalledWith("abc123");
    const [row] = auditRows(`container.${action}`);
    expect(row).toMatchObject({
      actor: "carol",
      role: "operator",
      target: "abc123",
      outcome: "success",
      detail: null,
      ip: expect.any(String),
    });
  });
});

describe("guards (stop as representative)", () => {
  it("rejects without a session — no docker call, no audit row", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/containers/abc123/stop",
    });

    expect(res.statusCode).toBe(401);
    expect(mocked.stopContainer).not.toHaveBeenCalled();
    expect(auditRows("container.stop")).toHaveLength(0);
  });

  it("rejects viewers with 403 and audits the denial", async () => {
    const viewer = await loginAs(app, "bob", "battery staple");

    const res = await post("/api/containers/abc123/stop", viewer);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Forbidden" });
    expect(mocked.stopContainer).not.toHaveBeenCalled();
    const [row] = auditRows("container.stop");
    expect(row).toMatchObject({
      actor: "bob",
      role: "viewer",
      target: "abc123",
      outcome: "failure",
      detail: "forbidden",
    });
  });

  it("lets admins act", async () => {
    mocked.stopContainer.mockResolvedValue({ state: "exited", noOp: false });
    const admin = await loginAs(app, "alice", "correct horse");

    const res = await post("/api/containers/abc123/stop", admin);

    expect(res.statusCode).toBe(200);
  });

  it("rejects invalid ids before any audit write or docker call", async () => {
    const res = await post("/api/containers/bad$id/stop");

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid container id" });
    expect(mocked.stopContainer).not.toHaveBeenCalled();
    expect(auditRows("container.stop")).toHaveLength(0);
  });
});

describe("outcomes", () => {
  it("maps Docker 404s to 404 and settles the audit row as failure", async () => {
    mocked.stopContainer.mockRejectedValue(
      Object.assign(new Error("no such container"), { statusCode: 404 }),
    );

    const res = await post("/api/containers/deadbeef/stop");

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: "Container not found",
      detail: "no such container",
    });
    expect(auditRows("container.stop")[0]).toMatchObject({
      outcome: "failure",
      detail: "no such container",
    });
  });

  it("maps daemon failures to 502 and settles the audit row as failure", async () => {
    mocked.restartContainer.mockRejectedValue(new Error("socket hang up"));

    const res = await post("/api/containers/abc123/restart");

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "Action failed", detail: "socket hang up" });
    expect(auditRows("container.restart")[0]).toMatchObject({
      outcome: "failure",
      detail: "socket hang up",
    });
  });

  it("notes 304 no-ops in the audit detail", async () => {
    mocked.startContainer.mockResolvedValue({ state: "running", noOp: true });

    const res = await post("/api/containers/abc123/start");

    expect(res.statusCode).toBe(200);
    expect(auditRows("container.start")[0]).toMatchObject({
      outcome: "success",
      detail: "no-op: already in desired state",
    });
  });

  it("fails closed: 503 when the audit write fails, docker never called", async () => {
    // Login above already succeeded (auth audits fail-open). Closing the
    // store makes the action route's recordEvent throw.
    closeDb();

    const res = await post("/api/containers/abc123/stop");

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "Audit log unavailable" });
    expect(mocked.stopContainer).not.toHaveBeenCalled();
  });
});
