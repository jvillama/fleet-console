import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeployPanel } from "../src/components/DeployPanel";
import type { ContainerSummary, Deployment } from "../src/types";
import { jsonResponse, stubFetch } from "./helpers";

const container: ContainerSummary = {
  id: "abc123",
  shortId: "abc123",
  name: "web-1",
  image: "nginx:1.27",
  state: "running",
  status: "Up 2 hours",
  createdAt: "2026-07-01T00:00:00.000Z",
  ports: [],
};

function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: 7,
    containerId: "abc123",
    containerName: "web-1",
    oldImage: "nginx:1.27",
    newImage: "nginx:1.28",
    status: "pulling",
    detail: null,
    actor: "alice",
    role: "admin",
    rollbackOf: null,
    newContainerId: null,
    startedAt: "2026-07-11T20:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function renderPanel(role: "admin" | "viewer" = "admin", onClose = vi.fn()) {
  render(
    <DeployPanel container={container} deploymentId={7} role={role} onClose={onClose} />,
  );
  return onClose;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function user() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
}

describe("DeployPanel", () => {
  it("shows the current phase and image transition while in flight", async () => {
    stubFetch({ "/api/deployments/7": deployment({ status: "recreating" }) });
    renderPanel();

    expect(await screen.findByText("nginx:1.27 → nginx:1.28")).toBeInTheDocument();
    expect(screen.getByText("recreating")).toHaveClass("current");
    expect(screen.getByText("pulling")).toHaveClass("done");
    expect(screen.getByText("watching")).toHaveClass("pending");
  });

  it("polls until terminal, then stops fetching and shows the outcome", async () => {
    let status: Deployment["status"] = "pulling";
    const { calls } = stubFetch({
      "/api/deployments/7": () => jsonResponse(deployment({ status })),
    });
    renderPanel();

    expect(await screen.findByText("pulling")).toBeInTheDocument();

    status = "succeeded";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(await screen.findByText("Deployment succeeded")).toBeInTheDocument();

    const countAtTerminal = calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(calls.length).toBe(countAtTerminal);
  });

  it("shows the failure detail and a rollback confirm for admins", async () => {
    stubFetch({
      "/api/deployments/7": deployment({
        status: "failed",
        detail: "container reported unhealthy",
      }),
    });
    renderPanel("admin");

    expect(
      await screen.findByText(/Deployment failed — container reported unhealthy/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Roll back" })).toBeInTheDocument();
  });

  it("hides rollback from non-admins", async () => {
    stubFetch({ "/api/deployments/7": deployment({ status: "failed", detail: "x" }) });
    renderPanel("viewer");

    await screen.findByText(/Deployment failed/);
    expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull();
  });

  it("rollback confirm starts the new deployment and follows it", async () => {
    stubFetch({
      "/api/deployments/7/rollback": jsonResponse({ deploymentId: 8 }, 202),
      "/api/deployments/7": deployment({ status: "failed", detail: "x" }),
      "/api/deployments/8": deployment({
        id: 8,
        status: "pulling",
        oldImage: "nginx:1.28",
        newImage: "nginx:1.27",
        rollbackOf: 7,
      }),
    });
    renderPanel("admin");
    const u = user();

    await u.click(await screen.findByRole("button", { name: "Roll back" }));
    await u.click(screen.getByRole("button", { name: "Confirm roll back?" }));

    expect(await screen.findByText("nginx:1.28 → nginx:1.27")).toBeInTheDocument();
  });

  it("calls onClose from the close button", async () => {
    stubFetch({ "/api/deployments/7": deployment() });
    const onClose = renderPanel();
    const u = user();

    await u.click(await screen.findByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
