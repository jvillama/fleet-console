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
  default: vi.fn(function() {
    return mockClient;
  }),
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
  vi.resetAllMocks();
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

  it("returns 0 cpuPercent when counters reset to a negative delta", async () => {
    mockStats(
      statsFixture({
        cpu_stats: {
          cpu_usage: { total_usage: 100 },
          system_cpu_usage: 3000,
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
