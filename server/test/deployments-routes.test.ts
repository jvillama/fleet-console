import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
}));

import * as dockerApi from "../src/docker.js";
import { buildApp } from "../src/app.js";
import { queryEvents } from "../src/audit.js";
import { closeDb } from "../src/db.js";
import {
  createDeployment,
  getDeployment,
  updateDeploymentStatus,
} from "../src/deployments.js";
import type { RecreateSpec } from "../src/docker.js";
import { loginAs } from "./helpers.js";

const mocked = vi.mocked(dockerApi);

let app: FastifyInstance;
let admin: { session: string };

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

function happyDockerMocks() {
  mocked.inspectForRecreate.mockResolvedValue(spec());
  mocked.pullImage.mockResolvedValue(undefined);
  mocked.recreateContainer.mockResolvedValue("newid987");
  mocked.watchHealth.mockResolvedValue({ healthy: true });
  mocked.removeContainer.mockResolvedValue(undefined);
}

function deploy(
  body: unknown = { tag: "1.28" },
  cookies: { session: string } = admin,
  id = "oldid123",
) {
  return app.inject({
    method: "POST",
    url: `/api/containers/${id}/deploy`,
    payload: body as Record<string, unknown>,
    cookies,
  });
}

async function waitForStatus(id: number, status: string): Promise<void> {
  await vi.waitFor(() => {
    expect(getDeployment(id)?.status).toBe(status);
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  app = await buildApp();
  admin = await loginAs(app, "alice", "correct horse");
});

afterEach(async () => {
  await app.close();
});

describe("POST /api/containers/:id/deploy", () => {
  it("202 for admins; row reaches succeeded; audit settles with actor and target", async () => {
    happyDockerMocks();

    const res = await deploy();

    expect(res.statusCode).toBe(202);
    const { deploymentId } = res.json() as { deploymentId: number };
    await waitForStatus(deploymentId, "succeeded");
    const [event] = queryEvents({ limit: 1, offset: 0, action: "container.deploy" }).events;
    expect(event).toMatchObject({
      actor: "alice",
      role: "admin",
      target: "oldid123",
      outcome: "success",
      ip: expect.any(String),
    });
  });

  it("401 without a session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/containers/oldid123/deploy",
      payload: { tag: "1.28" },
    });
    expect(res.statusCode).toBe(401);
    expect(mocked.inspectForRecreate).not.toHaveBeenCalled();
  });

  it.each([
    ["viewer", "bob", "battery staple"],
    ["operator", "carol", "staple correct"],
  ])("403 for %s roles, with an audited denial", async (_role, user, password) => {
    const cookies = await loginAs(app, user, password);

    const res = await deploy(undefined, cookies);

    expect(res.statusCode).toBe(403);
    expect(mocked.inspectForRecreate).not.toHaveBeenCalled();
    const [event] = queryEvents({ limit: 1, offset: 0, action: "container.deploy" }).events;
    expect(event).toMatchObject({ actor: user, outcome: "failure", detail: "forbidden" });
  });

  it("400 for a malformed tag, before any audit write or docker call", async () => {
    const res = await deploy({ tag: "bad tag!" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid image tag" });
    expect(mocked.inspectForRecreate).not.toHaveBeenCalled();
    expect(queryEvents({ limit: 5, offset: 0, action: "container.deploy" }).total).toBe(0);
  });

  it("400 for an invalid container id", async () => {
    const res = await deploy(undefined, admin, "bad$id");
    expect(res.statusCode).toBe(400);
  });

  it("404 when the container does not exist, audit settled as failure", async () => {
    mocked.inspectForRecreate.mockRejectedValue(
      Object.assign(new Error("no such container"), { statusCode: 404 }),
    );

    const res = await deploy();

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Container not found" });
    const [event] = queryEvents({ limit: 1, offset: 0, action: "container.deploy" }).events;
    expect(event).toMatchObject({ outcome: "failure", detail: "Container not found" });
  });

  it("422 when the container already runs the requested tag", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());

    const res = await deploy({ tag: "1.27" });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "Container already runs that image" });
  });

  it("409 while a deploy is active for the container", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());
    let releasePull!: () => void;
    mocked.pullImage.mockReturnValue(new Promise((res) => (releasePull = () => res())));

    const first = await deploy();
    expect(first.statusCode).toBe(202);

    const second = await deploy();
    expect(second.statusCode).toBe(409);

    mocked.recreateContainer.mockResolvedValue("newid987");
    mocked.watchHealth.mockResolvedValue({ healthy: true });
    mocked.removeContainer.mockResolvedValue(undefined);
    releasePull();
    const { deploymentId } = first.json() as { deploymentId: number };
    await waitForStatus(deploymentId, "succeeded");
  });

  it("fails closed: 503 when the audit write fails, docker never touched", async () => {
    closeDb();

    const res = await deploy();

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "Audit log unavailable" });
    expect(mocked.inspectForRecreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/deployments/:id/rollback", () => {
  function seedFinished(): number {
    const id = createDeployment({
      containerId: "oldid123",
      containerName: "web-1",
      oldImage: "nginx:1.27",
      newImage: "nginx:1.28",
      actor: "alice",
      role: "admin",
    });
    updateDeploymentStatus(id, "succeeded", { newContainerId: "newid987" });
    return id;
  }

  it("202 starts a linked deployment targeting the old image", async () => {
    const sourceId = seedFinished();
    // The current container (post-deploy) runs 1.28; rollback goes to 1.27.
    mocked.inspectForRecreate.mockResolvedValue(spec({ image: "nginx:1.28" }));
    mocked.pullImage.mockResolvedValue(undefined);
    mocked.recreateContainer.mockResolvedValue("newerid555");
    mocked.watchHealth.mockResolvedValue({ healthy: true });
    mocked.removeContainer.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: `/api/deployments/${sourceId}/rollback`,
      cookies: admin,
    });

    expect(res.statusCode).toBe(202);
    const { deploymentId } = res.json() as { deploymentId: number };
    await waitForStatus(deploymentId, "succeeded");
    expect(getDeployment(deploymentId)).toMatchObject({
      newImage: "nginx:1.27",
      rollbackOf: sourceId,
    });
    expect(mocked.inspectForRecreate).toHaveBeenCalledWith("web-1");
    const [event] = queryEvents({ limit: 1, offset: 0, action: "container.rollback" }).events;
    expect(event).toMatchObject({ outcome: "success", target: "web-1" });
  });

  it("404 for an unknown deployment id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/deployments/999/rollback",
      cookies: admin,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Deployment not found" });
  });

  it("422 when the container already runs the rollback image", async () => {
    const sourceId = seedFinished();
    mocked.inspectForRecreate.mockResolvedValue(spec({ image: "nginx:1.27" }));

    const res = await app.inject({
      method: "POST",
      url: `/api/deployments/${sourceId}/rollback`,
      cookies: admin,
    });
    expect(res.statusCode).toBe(422);
  });

  it("403 for operators", async () => {
    const sourceId = seedFinished();
    const carol = await loginAs(app, "carol", "staple correct");

    const res = await app.inject({
      method: "POST",
      url: `/api/deployments/${sourceId}/rollback`,
      cookies: carol,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/deployments", () => {
  it("returns one deployment by id, 404 when unknown", async () => {
    const id = createDeployment({
      containerId: "a",
      containerName: "web-1",
      oldImage: "nginx:1.27",
      newImage: "nginx:1.28",
      actor: "alice",
      role: "admin",
    });

    const ok = await app.inject({ url: `/api/deployments/${id}`, cookies: admin });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id, containerName: "web-1", status: "pending" });

    const missing = await app.inject({ url: "/api/deployments/999", cookies: admin });
    expect(missing.statusCode).toBe(404);
  });

  it("lists deployments filtered by container name, any role", async () => {
    for (const name of ["web-1", "web-2", "web-1"]) {
      createDeployment({
        containerId: "a",
        containerName: name,
        oldImage: "nginx:1.27",
        newImage: "nginx:1.28",
        actor: "alice",
        role: "admin",
      });
    }
    const viewer = await loginAs(app, "bob", "battery staple");

    const res = await app.inject({
      url: "/api/deployments?container=web-1&limit=10",
      cookies: viewer,
    });

    expect(res.statusCode).toBe(200);
    const page = res.json() as { deployments: { containerName: string }[]; total: number };
    expect(page.total).toBe(2);
    expect(page.deployments.every((d) => d.containerName === "web-1")).toBe(true);
  });
});

describe("startup sweep", () => {
  it("marks rows left non-terminal by a previous process as failed on boot", async () => {
    // :memory: gives every buildApp a fresh database, so a real restart
    // needs a file-backed one.
    const tmpDir = mkdtempSync(join(tmpdir(), "fleet-deploy-"));
    const prevPath = process.env.AUDIT_DB_PATH;
    process.env.AUDIT_DB_PATH = join(tmpDir, "audit.db");
    try {
      const app1 = await buildApp();
      const id = createDeployment({
        containerId: "a",
        containerName: "web-1",
        oldImage: "nginx:1.27",
        newImage: "nginx:1.28",
        actor: "alice",
        role: "admin",
      });
      updateDeploymentStatus(id, "watching");
      await app1.close();

      const app2 = await buildApp(); // restart — sweep runs during build
      expect(getDeployment(id)).toMatchObject({
        status: "failed",
        detail: "interrupted by server restart",
      });
      await app2.close();
    } finally {
      process.env.AUDIT_DB_PATH = prevPath;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
