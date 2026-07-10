import { render, screen, within } from "@testing-library/react";
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
    render(<FleetTable containers={[]} onSelect={vi.fn()} />);

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

    render(<FleetTable containers={[running, stopped]} onSelect={vi.fn()} />);

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

    render(<FleetTable containers={[ok, broken]} onSelect={vi.fn()} />);

    expect(await screen.findByText("2.5%")).toBeInTheDocument();
    const brokenRow = rowFor("web-2");
    expect(within(brokenRow).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("clicking a row selects its container", async () => {
    stubFetch({ "/api/containers/run1/stats": jsonResponse(statsFixture) });
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const c = container({});

    render(<FleetTable containers={[c]} onSelect={onSelect} />);
    await user.click(screen.getByText("web-1"));

    expect(onSelect).toHaveBeenCalledWith(c);
  });
});
