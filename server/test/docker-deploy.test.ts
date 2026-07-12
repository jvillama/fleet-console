import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// docker.ts creates its dockerode client at module load, so the mock must
// intercept the constructor before ../src/docker.js is imported.
const mockClient = vi.hoisted(() => ({
  listContainers: vi.fn(),
  getContainer: vi.fn(),
  createContainer: vi.fn(),
  getNetwork: vi.fn(),
  pull: vi.fn(),
  version: vi.fn(),
  info: vi.fn(),
  ping: vi.fn(),
  modem: { demuxStream: vi.fn(), followProgress: vi.fn() },
}));

vi.mock("dockerode", () => ({
  default: vi.fn(function () {
    return mockClient;
  }),
}));

import {
  inspectForRecreate,
  pullImage,
  recreateContainer,
  removeContainer,
  watchHealth,
  type RecreateSpec,
} from "../src/docker.js";

function inspectFixture(overrides: Record<string, unknown> = {}) {
  return {
    Id: "oldid1234567890",
    Name: "/web-1",
    State: { Status: "running", Running: true },
    Config: {
      Image: "nginx:1.27",
      Env: ["FOO=bar"],
      Cmd: ["nginx", "-g", "daemon off;"],
      Entrypoint: null,
      Labels: { "com.example": "1" },
      ExposedPorts: { "80/tcp": {} },
      WorkingDir: "",
      User: "",
    },
    HostConfig: {
      NetworkMode: "fleet_default",
      RestartPolicy: { Name: "unless-stopped" },
      Binds: ["vol:/data"],
    },
    NetworkSettings: {
      Networks: {
        fleet_default: { Aliases: ["web-1", "oldid1234567"] },
        backnet: { Aliases: ["web", "oldid1234567"] },
      },
    },
    ...overrides,
  };
}

function specFixture(overrides: Partial<RecreateSpec> = {}): RecreateSpec {
  return {
    id: "oldid1234567890",
    name: "web-1",
    image: "nginx:1.27",
    wasRunning: true,
    createOptions: { Env: ["FOO=bar"], HostConfig: { NetworkMode: "fleet_default" } },
    extraNetworks: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pullImage", () => {
  it("resolves when followProgress reports completion", async () => {
    const stream = {};
    mockClient.pull.mockResolvedValue(stream);
    mockClient.modem.followProgress.mockImplementation(
      (_s: unknown, done: (err: Error | null) => void) => done(null),
    );

    await expect(pullImage("nginx:1.28")).resolves.toBeUndefined();
    expect(mockClient.pull).toHaveBeenCalledWith("nginx:1.28");
  });

  it("rejects when the pull stream errors", async () => {
    mockClient.pull.mockResolvedValue({});
    mockClient.modem.followProgress.mockImplementation(
      (_s: unknown, done: (err: Error | null) => void) => done(new Error("manifest unknown")),
    );

    await expect(pullImage("nginx:bogus")).rejects.toThrow("manifest unknown");
  });
});

describe("inspectForRecreate", () => {
  it("captures name, image, running state, config, and extra networks", async () => {
    mockClient.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue(inspectFixture()),
    });

    const spec = await inspectForRecreate("web-1");

    expect(spec.id).toBe("oldid1234567890");
    expect(spec.name).toBe("web-1");
    expect(spec.image).toBe("nginx:1.27");
    expect(spec.wasRunning).toBe(true);
    expect(spec.createOptions.Env).toEqual(["FOO=bar"]);
    expect(spec.createOptions.HostConfig?.NetworkMode).toBe("fleet_default");
    // The NetworkMode network is attached at create; only others are extra,
    // and Docker's own short-id alias is dropped.
    expect(spec.extraNetworks).toEqual([{ name: "backnet", aliases: ["web"] }]);
  });
});

describe("recreateContainer", () => {
  function happyMocks() {
    const old = {
      stop: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const created = { id: "newid987", start: vi.fn().mockResolvedValue(undefined) };
    mockClient.getContainer.mockReturnValue(old);
    mockClient.createContainer.mockResolvedValue(created);
    const network = { connect: vi.fn().mockResolvedValue(undefined) };
    mockClient.getNetwork.mockReturnValue(network);
    return { old, created, network };
  }

  it("stops, renames, creates with the new image and original name, starts", async () => {
    const { old, created } = happyMocks();

    const newId = await recreateContainer(specFixture(), "nginx:1.28", 7);

    expect(newId).toBe("newid987");
    expect(old.stop).toHaveBeenCalled();
    expect(old.rename).toHaveBeenCalledWith({ name: "web-1-predeploy-7" });
    expect(mockClient.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({ name: "web-1", Image: "nginx:1.28", Env: ["FOO=bar"] }),
    );
    expect(created.start).toHaveBeenCalled();
  });

  it("skips stop for a container that was not running", async () => {
    const { old } = happyMocks();

    await recreateContainer(specFixture({ wasRunning: false }), "nginx:1.28", 7);

    expect(old.stop).not.toHaveBeenCalled();
  });

  it("swallows a 304 from stop (already stopped)", async () => {
    const { old } = happyMocks();
    old.stop.mockRejectedValue(Object.assign(new Error("not modified"), { statusCode: 304 }));

    await expect(recreateContainer(specFixture(), "nginx:1.28", 7)).resolves.toBe("newid987");
  });

  it("connects extra networks with their aliases before starting", async () => {
    const { network } = happyMocks();
    const spec = specFixture({ extraNetworks: [{ name: "backnet", aliases: ["web"] }] });

    await recreateContainer(spec, "nginx:1.28", 7);

    expect(mockClient.getNetwork).toHaveBeenCalledWith("backnet");
    expect(network.connect).toHaveBeenCalledWith({
      Container: "newid987",
      EndpointConfig: { Aliases: ["web"] },
    });
  });

  it("restores the original on create failure and rethrows", async () => {
    const { old } = happyMocks();
    mockClient.createContainer.mockRejectedValue(new Error("invalid mount"));

    await expect(recreateContainer(specFixture(), "nginx:1.28", 7)).rejects.toThrow(
      "invalid mount",
    );
    expect(old.rename).toHaveBeenLastCalledWith({ name: "web-1" });
    expect(old.start).toHaveBeenCalled(); // it was running before
  });

  it("removes the half-created container on start failure, then restores", async () => {
    const { old, created } = happyMocks();
    created.start.mockRejectedValue(new Error("oom"));
    const removeNew = vi.fn().mockResolvedValue(undefined);
    // getContainer is called for the old container first, then for cleanup
    // of the new one.
    mockClient.getContainer.mockImplementation((id: string) =>
      id === "newid987" ? { remove: removeNew } : old,
    );

    await expect(recreateContainer(specFixture(), "nginx:1.28", 7)).rejects.toThrow("oom");
    expect(removeNew).toHaveBeenCalledWith({ force: true });
    expect(old.rename).toHaveBeenLastCalledWith({ name: "web-1" });
  });
});

describe("removeContainer", () => {
  it("removes by id", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    mockClient.getContainer.mockReturnValue({ remove });

    await removeContainer("oldid");

    expect(remove).toHaveBeenCalled();
  });
});

describe("watchHealth", () => {
  function mockInspectSequence(states: Record<string, unknown>[]) {
    const inspect = vi.fn();
    for (const s of states) inspect.mockResolvedValueOnce({ State: s });
    inspect.mockResolvedValue({ State: states[states.length - 1] });
    mockClient.getContainer.mockReturnValue({ inspect });
    return inspect;
  }

  it("succeeds when a healthchecked container reports healthy", async () => {
    vi.useFakeTimers();
    mockInspectSequence([
      { Status: "running", Running: true, Health: { Status: "starting" } },
      { Status: "running", Running: true, Health: { Status: "healthy" } },
    ]);

    const promise = watchHealth("newid");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toEqual({ healthy: true });
  });

  it("fails as soon as the container reports unhealthy", async () => {
    vi.useFakeTimers();
    mockInspectSequence([
      { Status: "running", Running: true, Health: { Status: "starting" } },
      { Status: "running", Running: true, Health: { Status: "unhealthy" } },
    ]);

    const promise = watchHealth("newid");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toEqual({
      healthy: false,
      reason: "container reported unhealthy",
    });
  });

  it("fails when the 60s deadline passes without healthy", async () => {
    vi.useFakeTimers();
    mockInspectSequence([{ Status: "running", Running: true, Health: { Status: "starting" } }]);

    const promise = watchHealth("newid");
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(promise).resolves.toEqual({
      healthy: false,
      reason: "health check deadline (60s) exceeded",
    });
  });

  it("without a healthcheck, succeeds when still running after the grace period", async () => {
    vi.useFakeTimers();
    mockInspectSequence([
      { Status: "running", Running: true },
      { Status: "running", Running: true },
    ]);

    const promise = watchHealth("newid");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toEqual({ healthy: true });
  });

  it("without a healthcheck, fails when the container exited within the grace period", async () => {
    vi.useFakeTimers();
    mockInspectSequence([
      { Status: "running", Running: true },
      { Status: "exited", Running: false },
    ]);

    const promise = watchHealth("newid");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toEqual({
      healthy: false,
      reason: "container exited during 10s grace period",
    });
  });
});
