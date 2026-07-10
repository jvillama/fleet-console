import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LogPanel } from "../src/components/LogPanel";
import type { ContainerSummary } from "../src/types";
import { FakeWebSocket, installFakeWebSocket } from "./helpers";

const c: ContainerSummary = {
  id: "abc123",
  shortId: "abc123short0",
  name: "web-1",
  image: "nginx:1.27",
  state: "running",
  status: "Up 2 hours",
  createdAt: "2026-07-10T00:00:00.000Z",
  ports: [],
};

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("no FakeWebSocket instance");
  return socket;
}

describe("LogPanel", () => {
  it("connects to the container's log socket and starts in connecting", () => {
    installFakeWebSocket();

    render(<LogPanel container={c} onClose={vi.fn()} />);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(lastSocket().url).toBe(`ws://${window.location.host}/api/logs/${c.id}`);
    expect(screen.getByText("connecting")).toBeInTheDocument();
  });

  it("streams frames as log lines once open", () => {
    installFakeWebSocket();
    render(<LogPanel container={c} onClose={vi.fn()} />);

    act(() => lastSocket().fireOpen());
    expect(screen.getByText("streaming")).toBeInTheDocument();

    act(() => {
      lastSocket().fireMessage("first line");
      lastSocket().fireMessage("second line");
    });

    expect(screen.getByText("first line")).toBeInTheDocument();
    expect(screen.getByText("second line")).toBeInTheDocument();
  });

  it("caps the buffer at 2000 lines, dropping the oldest", () => {
    installFakeWebSocket();
    const { container: dom } = render(<LogPanel container={c} onClose={vi.fn()} />);

    act(() => {
      const socket = lastSocket();
      socket.fireOpen();
      for (let i = 1; i <= 2005; i++) socket.fireMessage(`line ${i}`);
    });

    expect(dom.querySelectorAll(".log-line")).toHaveLength(2000);
    expect(screen.queryByText("line 5")).not.toBeInTheDocument();
    expect(screen.getByText("line 6")).toBeInTheDocument();
    expect(screen.getByText("line 2005")).toBeInTheDocument();
  });

  it("maps close codes to ended / disconnected with the reason", () => {
    installFakeWebSocket();
    const { unmount } = render(<LogPanel container={c} onClose={vi.fn()} />);

    act(() => lastSocket().fireClose(1000, "stream ended"));
    expect(screen.getByText("ended — stream ended")).toBeInTheDocument();
    unmount();

    installFakeWebSocket();
    render(<LogPanel container={c} onClose={vi.fn()} />);
    act(() => lastSocket().fireClose(1011, "daemon gone"));
    expect(screen.getByText("disconnected — daemon gone")).toBeInTheDocument();
  });

  it("closes on Escape and closes the socket on unmount", () => {
    installFakeWebSocket();
    const onClose = vi.fn();
    const { unmount } = render(<LogPanel container={c} onClose={onClose} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    const socket = lastSocket();
    unmount();
    expect(socket.close).toHaveBeenCalled();
  });

  it("auto-scrolls while pinned and unpins on scroll-up", () => {
    installFakeWebSocket();
    const { container: dom } = render(<LogPanel container={c} onClose={vi.fn()} />);
    const scroller = dom.querySelector(".log-lines");
    if (!(scroller instanceof HTMLElement)) throw new Error("no scroller");

    // jsdom has no layout: define the geometry the component reads.
    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    act(() => {
      lastSocket().fireOpen();
      lastSocket().fireMessage("a line");
    });
    expect(scrollTop).toBe(1000); // pinned: scrolled to bottom

    scrollTop = 100; // user scrolls up
    fireEvent.scroll(scroller);
    expect(screen.getByRole("button", { name: /Jump to latest/ })).toBeInTheDocument();

    act(() => lastSocket().fireMessage("another line"));
    expect(scrollTop).toBe(100); // unpinned: no auto-scroll
  });
});
