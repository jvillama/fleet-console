import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb } from "../src/db.js";
import {
  createDeployment,
  failInterrupted,
  findActiveDeployment,
  getDeployment,
  queryDeployments,
  updateDeploymentStatus,
} from "../src/deployments.js";

beforeEach(() => {
  initDb(":memory:");
});

afterEach(() => {
  closeDb();
});

function seed(overrides: Partial<Parameters<typeof createDeployment>[0]> = {}) {
  return createDeployment({
    containerId: "abc123",
    containerName: "web-1",
    oldImage: "nginx:1.27",
    newImage: "nginx:1.28",
    actor: "alice",
    role: "admin",
    ...overrides,
  });
}

describe("createDeployment / getDeployment", () => {
  it("round-trips a row with pending status and null optionals", () => {
    const id = seed();

    const dep = getDeployment(id);
    expect(dep).toMatchObject({
      id,
      containerId: "abc123",
      containerName: "web-1",
      oldImage: "nginx:1.27",
      newImage: "nginx:1.28",
      status: "pending",
      detail: null,
      actor: "alice",
      role: "admin",
      rollbackOf: null,
      newContainerId: null,
      finishedAt: null,
    });
    expect(dep?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("records rollback_of when given", () => {
    const first = seed();
    const second = seed({ rollbackOf: first, oldImage: "nginx:1.28", newImage: "nginx:1.27" });
    expect(getDeployment(second)?.rollbackOf).toBe(first);
  });

  it("returns null for an unknown id", () => {
    expect(getDeployment(999)).toBeNull();
  });
});

describe("updateDeploymentStatus", () => {
  it("advances status without finishing on non-terminal states", () => {
    const id = seed();
    updateDeploymentStatus(id, "pulling");
    expect(getDeployment(id)).toMatchObject({ status: "pulling", finishedAt: null });
  });

  it("stores the patch fields and stamps finished_at on terminal states", () => {
    const id = seed();
    updateDeploymentStatus(id, "watching", { newContainerId: "def456" });
    updateDeploymentStatus(id, "succeeded", { detail: "nginx:1.27 → nginx:1.28" });

    const dep = getDeployment(id);
    expect(dep).toMatchObject({
      status: "succeeded",
      newContainerId: "def456",
      detail: "nginx:1.27 → nginx:1.28",
    });
    expect(dep?.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("throws for an unknown id", () => {
    expect(() => updateDeploymentStatus(999, "failed")).toThrow(/not found/);
  });
});

describe("queryDeployments", () => {
  it("filters by container name, newest first, with totals", () => {
    seed({ containerName: "web-1" });
    seed({ containerName: "web-2" });
    const latest = seed({ containerName: "web-1", newImage: "nginx:1.29" });

    const page = queryDeployments({ container: "web-1", limit: 10, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.deployments[0]?.id).toBe(latest);
    expect(page.deployments.every((d) => d.containerName === "web-1")).toBe(true);
  });

  it("paginates", () => {
    for (let i = 0; i < 5; i++) seed();
    const page = queryDeployments({ limit: 2, offset: 2 });
    expect(page.total).toBe(5);
    expect(page.deployments).toHaveLength(2);
  });
});

describe("findActiveDeployment", () => {
  it("finds only non-terminal rows for the name", () => {
    const done = seed();
    updateDeploymentStatus(done, "succeeded");
    expect(findActiveDeployment("web-1")).toBeNull();

    const running = seed();
    updateDeploymentStatus(running, "pulling");
    expect(findActiveDeployment("web-1")?.id).toBe(running);
    expect(findActiveDeployment("other")).toBeNull();
  });
});

describe("failInterrupted", () => {
  it("fails every non-terminal row and leaves terminal rows alone", () => {
    const done = seed();
    updateDeploymentStatus(done, "succeeded", { detail: "ok" });
    const stuck = seed();
    updateDeploymentStatus(stuck, "recreating");

    const swept = failInterrupted();

    expect(swept).toBe(1);
    expect(getDeployment(stuck)).toMatchObject({
      status: "failed",
      detail: "interrupted by server restart",
    });
    expect(getDeployment(stuck)?.finishedAt).not.toBeNull();
    expect(getDeployment(done)).toMatchObject({ status: "succeeded", detail: "ok" });
  });
});
