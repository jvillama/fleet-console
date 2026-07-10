import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/docker.js", () => ({
  getContainerStats: vi.fn(),
  getFleetOverview: vi.fn(),
  listContainers: vi.fn(),
  pingDocker: vi.fn(),
  streamContainerLogs: vi.fn(),
}));

import * as dockerApi from "../src/docker.js";
import { buildApp } from "../src/app.js";
import { loginAs } from "./helpers.js";

const mocked = vi.mocked(dockerApi);

let app: FastifyInstance;
let cookies: { session: string };

beforeEach(async () => {
  vi.resetAllMocks();
  app = await buildApp();
  cookies = await loginAs(app);
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

describe("auth gate", () => {
  it.each(["/api/overview", "/api/containers", "/api/containers/abc123/stats"])(
    "rejects %s without a session",
    async (url) => {
      const res = await app.inject({ url });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Unauthorized" });
    },
  );

  it("leaves /api/health open", async () => {
    mocked.pingDocker.mockResolvedValue(true);

    const res = await app.inject({ url: "/api/health" });

    expect(res.statusCode).toBe(200);
  });

  it("rejects an expired session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-09T08:00:00Z"));
    const oldCookies = await loginAs(app);

    vi.setSystemTime(new Date("2026-07-09T16:00:01Z")); // 8h + 1s later
    const res = await app.inject({ url: "/api/overview", cookies: oldCookies });

    expect(res.statusCode).toBe(401);
  });

  it("accepts a session younger than the TTL", async () => {
    mocked.getFleetOverview.mockResolvedValue({
      total: 0,
      running: 0,
      stopped: 0,
      dockerVersion: "27.1.1",
      hostName: "docker-host",
    });

    const res = await app.inject({ url: "/api/overview", cookies });

    expect(res.statusCode).toBe(200);
  });
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

    const res = await app.inject({ url: "/api/containers", cookies });

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

    const res = await app.inject({ url: "/api/overview", cookies });

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

    const res = await app.inject({ url: "/api/containers/abc123/stats", cookies });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(stats);
  });

  it("rejects ids with unexpected characters before touching Docker", async () => {
    const res = await app.inject({ url: "/api/containers/bad$id/stats", cookies });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid container id" });
    expect(mocked.getContainerStats).not.toHaveBeenCalled();
  });

  it("maps Docker 404s to a 404 response", async () => {
    mocked.getContainerStats.mockRejectedValue(
      Object.assign(new Error("no such container"), { statusCode: 404 }),
    );

    const res = await app.inject({ url: "/api/containers/deadbeef/stats", cookies });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: "Container not found",
      detail: "no such container",
    });
  });

  it("maps other Docker failures to a 502 response", async () => {
    mocked.getContainerStats.mockRejectedValue(new Error("socket hang up"));

    const res = await app.inject({ url: "/api/containers/abc123/stats", cookies });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: "Stats unavailable",
      detail: "socket hang up",
    });
  });
});
