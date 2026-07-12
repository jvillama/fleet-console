import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  inspectForRecreate: vi.fn(),
  recreateContainer: vi.fn(),
  removeContainer: vi.fn(),
  watchHealth: vi.fn(),
}));

import * as dockerApi from "../src/docker.js";
import { closeDb, initDb } from "../src/db.js";
import { queryEvents, recordEvent } from "../src/audit.js";
import { getDeployment } from "../src/deployments.js";
import { parseImageRef, requestDeploy } from "../src/deploy.js";
import type { RecreateSpec } from "../src/docker.js";

const mocked = vi.mocked(dockerApi);

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
  level: "silent",
} as never;

function spec(overrides: Partial<RecreateSpec> = {}): RecreateSpec {
  return {
    id: "oldid123",
    name: "web-1",
    image: "nginx:1.27",
    wasRunning: true,
    createOptions: {},
    extraNetworks: [],
    ...overrides,
  };
}

function auditRow(): number {
  return recordEvent({
    actor: "alice",
    role: "admin",
    action: "container.deploy",
    target: "web-1",
    outcome: "failure",
    detail: "incomplete",
  });
}

function baseParams(auditId: number) {
  return {
    container: "oldid123",
    tag: "1.28",
    actor: "alice",
    role: "admin" as const,
    auditId,
    log,
  };
}

async function waitForStatus(id: number, status: string): Promise<void> {
  await vi.waitFor(() => {
    expect(getDeployment(id)?.status).toBe(status);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  initDb(":memory:");
});

afterEach(() => {
  closeDb();
});

describe("parseImageRef", () => {
  it.each([
    ["nginx", { repo: "nginx", tag: "latest" }],
    ["nginx:1.27", { repo: "nginx", tag: "1.27" }],
    ["ghcr.io/acme/app:v2", { repo: "ghcr.io/acme/app", tag: "v2" }],
    ["localhost:5000/app", { repo: "localhost:5000/app", tag: "latest" }],
    ["nginx:1.27@sha256:abc", { repo: "nginx", tag: "1.27" }],
  ])("parses %s", (ref, expected) => {
    expect(parseImageRef(ref)).toEqual(expected);
  });

  it("returns null for bare image ids", () => {
    expect(parseImageRef("sha256:deadbeef")).toBeNull();
    expect(parseImageRef("0123456789abcdef")).toBeNull();
  });
});

describe("requestDeploy — validation", () => {
  it("404 when the container does not exist", async () => {
    mocked.inspectForRecreate.mockRejectedValue(
      Object.assign(new Error("no such container"), { statusCode: 404 }),
    );

    const result = await requestDeploy(baseParams(auditRow()));

    expect(result).toEqual({ ok: false, code: 404, error: "Container not found" });
  });

  it("502 when inspect fails for other reasons", async () => {
    mocked.inspectForRecreate.mockRejectedValue(new Error("socket hang up"));

    const result = await requestDeploy(baseParams(auditRow()));

    expect(result).toEqual({ ok: false, code: 502, error: "socket hang up" });
  });

  it("422 when the image has no repository to retag", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec({ image: "sha256:deadbeef" }));

    const result = await requestDeploy(baseParams(auditRow()));

    expect(result).toMatchObject({ ok: false, code: 422 });
  });

  it("422 when the container already runs the requested image", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());

    const result = await requestDeploy({ ...baseParams(auditRow()), tag: "1.27" });

    expect(result).toEqual({
      ok: false,
      code: 422,
      error: "Container already runs that image",
    });
  });

  it("409 while another deploy is active for the same container", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());
    // Park the first pipeline inside pullImage forever.
    let releasePull!: () => void;
    mocked.pullImage.mockReturnValue(new Promise((res) => (releasePull = () => res())));

    const first = await requestDeploy(baseParams(auditRow()));
    expect(first.ok).toBe(true);

    const second = await requestDeploy(baseParams(auditRow()));
    expect(second).toMatchObject({ ok: false, code: 409 });

    releasePull();
    mocked.recreateContainer.mockResolvedValue("newid987");
    mocked.watchHealth.mockResolvedValue({ healthy: true });
    mocked.removeContainer.mockResolvedValue(undefined);
    if (first.ok) await waitForStatus(first.deploymentId, "succeeded");
  });
});

describe("requestDeploy — pipeline", () => {
  function happyMocks() {
    mocked.inspectForRecreate.mockResolvedValue(spec());
    mocked.pullImage.mockResolvedValue(undefined);
    mocked.recreateContainer.mockResolvedValue("newid987");
    mocked.watchHealth.mockResolvedValue({ healthy: true });
    mocked.removeContainer.mockResolvedValue(undefined);
  }

  it("runs to succeeded, records ids and images, settles the audit row", async () => {
    happyMocks();
    const auditId = auditRow();

    const result = await requestDeploy(baseParams(auditId));
    expect(result).toEqual({ ok: true, deploymentId: expect.any(Number) });
    if (!result.ok) return;

    await waitForStatus(result.deploymentId, "succeeded");
    expect(getDeployment(result.deploymentId)).toMatchObject({
      containerName: "web-1",
      oldImage: "nginx:1.27",
      newImage: "nginx:1.28",
      newContainerId: "newid987",
      detail: "nginx:1.27 → nginx:1.28",
      rollbackOf: null,
    });
    expect(mocked.pullImage).toHaveBeenCalledWith("nginx:1.28");
    expect(mocked.removeContainer).toHaveBeenCalledWith("oldid123");
    const [event] = queryEvents({ limit: 1, offset: 0 }).events;
    expect(event).toMatchObject({ outcome: "success", detail: "nginx:1.27 → nginx:1.28" });
  });

  it("explicit image param is used verbatim (rollback path)", async () => {
    happyMocks();
    const result = await requestDeploy({
      container: "oldid123",
      image: "nginx:1.26",
      rollbackOf: 41,
      actor: "alice",
      role: "admin",
      auditId: auditRow(),
      log,
    });
    if (!result.ok) throw new Error("expected ok");

    await waitForStatus(result.deploymentId, "succeeded");
    expect(getDeployment(result.deploymentId)).toMatchObject({
      newImage: "nginx:1.26",
      rollbackOf: 41,
    });
    expect(mocked.pullImage).toHaveBeenCalledWith("nginx:1.26");
  });

  it("pull failure fails the deployment before the container is touched", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());
    mocked.pullImage.mockRejectedValue(new Error("manifest unknown"));
    const auditId = auditRow();

    const result = await requestDeploy(baseParams(auditId));
    if (!result.ok) throw new Error("expected ok");

    await waitForStatus(result.deploymentId, "failed");
    expect(getDeployment(result.deploymentId)?.detail).toBe("manifest unknown");
    expect(mocked.recreateContainer).not.toHaveBeenCalled();
    const [event] = queryEvents({ limit: 1, offset: 0 }).events;
    expect(event).toMatchObject({ outcome: "failure", detail: "manifest unknown" });
  });

  it("recreate failure fails the deployment with the docker error", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());
    mocked.pullImage.mockResolvedValue(undefined);
    mocked.recreateContainer.mockRejectedValue(new Error("invalid mount"));

    const result = await requestDeploy(baseParams(auditRow()));
    if (!result.ok) throw new Error("expected ok");

    await waitForStatus(result.deploymentId, "failed");
    expect(getDeployment(result.deploymentId)?.detail).toBe("invalid mount");
  });

  it("health failure fails the deployment but keeps the new container", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());
    mocked.pullImage.mockResolvedValue(undefined);
    mocked.recreateContainer.mockResolvedValue("newid987");
    mocked.watchHealth.mockResolvedValue({
      healthy: false,
      reason: "container reported unhealthy",
    });

    const result = await requestDeploy(baseParams(auditRow()));
    if (!result.ok) throw new Error("expected ok");

    await waitForStatus(result.deploymentId, "failed");
    expect(getDeployment(result.deploymentId)).toMatchObject({
      detail: "container reported unhealthy",
      newContainerId: "newid987",
    });
    expect(mocked.removeContainer).not.toHaveBeenCalled();
  });

  it("a new deploy is allowed after the previous one settles", async () => {
    happyMocks();
    const first = await requestDeploy(baseParams(auditRow()));
    if (!first.ok) throw new Error("expected ok");
    await waitForStatus(first.deploymentId, "succeeded");

    const second = await requestDeploy({ ...baseParams(auditRow()), tag: "1.29" });
    expect(second.ok).toBe(true);
    if (second.ok) await waitForStatus(second.deploymentId, "succeeded");
  });
});
