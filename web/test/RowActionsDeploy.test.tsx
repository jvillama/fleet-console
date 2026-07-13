import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RowActions } from "../src/components/RowActions";
import type { ContainerSummary } from "../src/types";
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

function renderRow(role: "admin" | "operator", onDeployStarted = vi.fn()) {
  render(
    <table>
      <tbody>
        <tr>
          <td>
            <RowActions
              container={container}
              state="running"
              role={role}
              onStateChange={vi.fn()}
              onDeployStarted={onDeployStarted}
            />
          </td>
        </tr>
      </tbody>
    </table>,
  );
  return onDeployStarted;
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

describe("RowActions deploy flow", () => {
  it("shows Deploy only for admins", () => {
    renderRow("operator");
    expect(screen.queryByRole("button", { name: "Deploy" })).toBeNull();
    cleanup();
    renderRow("admin");
    expect(screen.getByRole("button", { name: "Deploy" })).toBeInTheDocument();
  });

  it("expands to a tag input; confirm POSTs and reports the deployment id", async () => {
    const { calls } = stubFetch({
      "/api/containers/abc123/deploy": jsonResponse({ deploymentId: 7 }, 202),
    });
    const onDeployStarted = renderRow("admin");
    const u = user();

    await u.click(screen.getByRole("button", { name: "Deploy" }));
    await u.type(screen.getByPlaceholderText("new tag"), "1.28");
    await u.click(screen.getByRole("button", { name: "Deploy tag" }));

    expect(calls[0]?.url).toBe("/api/containers/abc123/deploy");
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ tag: "1.28" });
    expect(onDeployStarted).toHaveBeenCalledWith(container, 7);
  });

  it("confirm is disabled until a tag is typed, and Cancel collapses the form", async () => {
    renderRow("admin");
    const u = user();

    await u.click(screen.getByRole("button", { name: "Deploy" }));
    expect(screen.getByRole("button", { name: "Deploy tag" })).toBeDisabled();

    await u.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText("new tag")).toBeNull();
  });

  it("shows the error and keeps the form when the request fails", async () => {
    stubFetch({
      "/api/containers/abc123/deploy": jsonResponse({ error: "conflict" }, 409),
    });
    const onDeployStarted = renderRow("admin");
    const u = user();

    await u.click(screen.getByRole("button", { name: "Deploy" }));
    await u.type(screen.getByPlaceholderText("new tag"), "1.28");
    await u.click(screen.getByRole("button", { name: "Deploy tag" }));

    expect(onDeployStarted).not.toHaveBeenCalled();
    expect(screen.getByText(/conflict/)).toBeInTheDocument();
  });
});
