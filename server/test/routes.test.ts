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
