import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FleetTable } from "../src/components/FleetTable";
import type { ContainerSummary } from "../src/types";
import { jsonResponse, stubFetch } from "./helpers";

function container(overrides: Partial<ContainerSummary>): ContainerSummary {
  return {
    id: "run1",
    shortId: "run1short000",
    name: "web-1",
    image: "nginx:1.27",
    state: "running",
    status: "Up 2 hours",
    createdAt: "2026-07-10T00:00:00.000Z",
    ports: [],
    ...overrides,
  };
}

const statsFixture = {
  id: "run1",
  cpuPercent: 2.5,
  memoryUsageBytes: 104857600,
  memoryLimitBytes: 419430400,
  memoryPercent: 25,
  sampledAt: "2026-07-10T00:00:00.000Z",
};

function rowFor(name: string): HTMLElement {
  const cell = screen.getByText(name);
  const row = cell.closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("FleetTable", () => {
  it("renders the empty state when there are no containers", () => {
    render(
      <FleetTable containers={[]} role="viewer" onSelect={vi.fn()} onDeployStarted={vi.fn()} />,
    );

    expect(screen.getByText("No containers on this host yet.")).toBeInTheDocument();
  });

  it("renders rows with ports, status LED, and stats", async () => {
    stubFetch({ "/api/containers/run1/stats": jsonResponse(statsFixture) });
    const running = container({
      ports: [
        { containerPort: 80, hostPort: 8080, protocol: "tcp" },
        { containerPort: 9000, protocol: "udp" },
      ],
    });
    const stopped = container({
      id: "dead1",
      shortId: "dead1short00",
      name: "worker-1",
      state: "exited",
      status: "Exited (0) 2 days ago",
    });

    render(
      <FleetTable
        containers={[running, stopped]}
        role="viewer"
        onSelect={vi.fn()}
        onDeployStarted={vi.fn()}
      />,
    );

    expect(await screen.findByText("2.5%")).toBeInTheDocument();
    const runningRow = rowFor("web-1");
    expect(within(runningRow).getByText("8080→80/tcp, 9000/udp")).toBeInTheDocument();
    expect(within(runningRow).getByRole("img", { name: "running" })).toBeInTheDocument();
    expect(within(runningRow).getByText("100.0 MiB / 400.0 MiB")).toBeInTheDocument();

    const stoppedRow = rowFor("worker-1");
    expect(within(stoppedRow).getByRole("img", { name: "exited" })).toBeInTheDocument();
    // Stopped containers fetch no stats: CPU and Memory degrade to "—".
    expect(within(stoppedRow).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("degrades a row to em-dashes when its stats fetch fails", async () => {
    stubFetch({
      "/api/containers/run1/stats": jsonResponse(statsFixture),
      "/api/containers/run2/stats": jsonResponse({ error: "boom" }, 502),
    });
    const ok = container({});
    const broken = container({ id: "run2", shortId: "run2short000", name: "web-2" });

    render(
      <FleetTable
        containers={[ok, broken]}
        role="viewer"
        onSelect={vi.fn()}
        onDeployStarted={vi.fn()}
      />,
    );

    expect(await screen.findByText("2.5%")).toBeInTheDocument();
    const brokenRow = rowFor("web-2");
    expect(within(brokenRow).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("clicking a row selects its container", async () => {
    stubFetch({ "/api/containers/run1/stats": jsonResponse(statsFixture) });
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const c = container({});

    render(
      <FleetTable
        containers={[c]}
        role="viewer"
        onSelect={onSelect}
        onDeployStarted={vi.fn()}
      />,
    );
    await user.click(screen.getByText("web-1"));

    expect(onSelect).toHaveBeenCalledWith(c);
  });
});

describe("FleetTable actions", () => {
  const actionResult = { id: "dead1", action: "start", state: "running" };

  function stopped(overrides: Partial<ContainerSummary> = {}): ContainerSummary {
    return container({
      id: "dead1",
      shortId: "dead1short00",
      name: "worker-1",
      state: "exited",
      status: "Exited (0) 2 days ago",
      ...overrides,
    });
  }

  it("viewers see no action buttons", () => {
    render(
      <FleetTable
        containers={[stopped()]}
        role="viewer"
        onSelect={vi.fn()}
        onDeployStarted={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /start|stop|restart/i })).toBeNull();
  });

  it("operators see Start on stopped rows, Stop and Restart on running rows", () => {
    stubFetch({ "/api/containers/run1/stats": jsonResponse(statsFixture) });

    render(
      <FleetTable
        containers={[container({}), stopped()]}
        role="operator"
        onSelect={vi.fn()}
        onDeployStarted={vi.fn()}
      />,
    );

    const runningRow = rowFor("web-1");
    expect(within(runningRow).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(within(runningRow).getByRole("button", { name: "Restart" })).toBeInTheDocument();
    expect(within(runningRow).queryByRole("button", { name: "Start" })).toBeNull();

    const stoppedRow = rowFor("worker-1");
    expect(within(stoppedRow).getByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(within(stoppedRow).queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("Start fires immediately, POSTs, and updates the row state", async () => {
    const { calls } = stubFetch({ "/api/containers/dead1/start": actionResult });
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <FleetTable
        containers={[stopped()]}
        role="admin"
        onSelect={onSelect}
        onDeployStarted={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Start" }));

    const post = calls.find((c) => c.url === "/api/containers/dead1/start");
    expect(post?.init?.method).toBe("POST");
    // Row reflects the returned state without waiting for the next poll.
    expect(await screen.findByRole("img", { name: "running" })).toBeInTheDocument();
    // The button click must not bubble into row selection (log panel).
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("Stop requires a second confirming click", async () => {
    const { calls } = stubFetch({
      "/api/containers/run1/stats": jsonResponse(statsFixture),
      "/api/containers/run1/stop": { id: "run1", action: "stop", state: "exited" },
    });
    const user = userEvent.setup();

    render(
      <FleetTable
        containers={[container({})]}
        role="operator"
        onSelect={vi.fn()}
        onDeployStarted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("button", { name: "Confirm stop?" })).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/containers/run1/stop")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Confirm stop?" }));
    expect(calls.some((c) => c.url === "/api/containers/run1/stop")).toBe(true);
    expect(await screen.findByRole("img", { name: "exited" })).toBeInTheDocument();
  });

  it("the confirm state reverts after the timeout", async () => {
    stubFetch({ "/api/containers/run1/stats": jsonResponse(statsFixture) });
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <FleetTable
        containers={[container({})]}
        role="operator"
        onSelect={vi.fn()}
        onDeployStarted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("button", { name: "Confirm stop?" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("a failed action shows an inline error on that row only", async () => {
    stubFetch({
      "/api/containers/dead1/start": jsonResponse({ error: "Action failed" }, 502),
    });
    const user = userEvent.setup();

    render(
      <FleetTable
        containers={[stopped()]}
        role="admin"
        onSelect={vi.fn()}
        onDeployStarted={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Start" }));

    const row = rowFor("worker-1");
    expect(await within(row).findByText(/Action failed/)).toBeInTheDocument();
    // No global banner — the table itself stays rendered.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
