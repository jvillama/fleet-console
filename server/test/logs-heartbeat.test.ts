import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeat } from "../src/routes/logs.js";

/** The shipped interval. Tests advance fake timers by this, so they also
 *  pin the default rather than only testing an injected override. */
const INTERVAL = 30_000;

/**
 * The slice of a ws WebSocket the heartbeat touches. `readyState` is
 * writable here so a test can simulate the socket closing between ticks;
 * the real socket updates it itself.
 */
function fakeSocket() {
  const calls = { pings: 0, terminates: 0 };
  return {
    readyState: 1,
    OPEN: 1,
    ping: () => void (calls.pings += 1),
    terminate: () => void (calls.terminates += 1),
    calls,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createHeartbeat", () => {
  it("pings once per interval while pongs keep arriving", () => {
    const socket = fakeSocket();
    const heartbeat = createHeartbeat(socket);

    vi.advanceTimersByTime(INTERVAL);
    expect(socket.calls.pings).toBe(1);

    heartbeat.pong();
    vi.advanceTimersByTime(INTERVAL);
    expect(socket.calls.pings).toBe(2);

    heartbeat.stop();
  });

  it("never terminates a peer that answers every ping", () => {
    const socket = fakeSocket();
    const heartbeat = createHeartbeat(socket);

    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(INTERVAL);
      heartbeat.pong();
    }

    expect(socket.calls.pings).toBe(5);
    expect(socket.calls.terminates).toBe(0);

    heartbeat.stop();
  });

  it("terminates on the second tick, not the first", () => {
    const socket = fakeSocket();
    createHeartbeat(socket);

    vi.advanceTimersByTime(INTERVAL);
    expect(socket.calls).toEqual({ pings: 1, terminates: 0 });

    vi.advanceTimersByTime(INTERVAL);
    expect(socket.calls).toEqual({ pings: 1, terminates: 1 });
  });

  it("stops the interval once it has terminated a dead peer", () => {
    const socket = fakeSocket();
    createHeartbeat(socket);

    vi.advanceTimersByTime(INTERVAL * 5);

    expect(socket.calls).toEqual({ pings: 1, terminates: 1 });
  });

  it("reports the timeout through onTimeout, before terminating", () => {
    const socket = fakeSocket();
    const order: string[] = [];
    createHeartbeat(
      { ...socket, terminate: () => void order.push("terminate") },
      { onTimeout: () => void order.push("onTimeout") },
    );

    vi.advanceTimersByTime(INTERVAL * 2);

    expect(order).toEqual(["onTimeout", "terminate"]);
  });

  it("does not call onTimeout on the healthy path", () => {
    const socket = fakeSocket();
    const onTimeout = vi.fn();
    const heartbeat = createHeartbeat(socket, { onTimeout });

    vi.advanceTimersByTime(INTERVAL);
    heartbeat.pong();
    vi.advanceTimersByTime(INTERVAL);

    expect(onTimeout).not.toHaveBeenCalled();

    heartbeat.stop();
  });

  it("goes silent after stop(), which is idempotent", () => {
    const socket = fakeSocket();
    const heartbeat = createHeartbeat(socket);

    heartbeat.stop();
    heartbeat.stop();
    vi.advanceTimersByTime(INTERVAL * 5);

    expect(socket.calls).toEqual({ pings: 0, terminates: 0 });
  });

  it("never pings a socket that is not OPEN", () => {
    const socket = fakeSocket();
    socket.readyState = 3; // CLOSED
    createHeartbeat(socket);

    vi.advanceTimersByTime(INTERVAL * 5);

    expect(socket.calls).toEqual({ pings: 0, terminates: 0 });
  });

  it("stops rather than terminating a socket that closed while awaiting a pong", () => {
    const socket = fakeSocket();
    createHeartbeat(socket);

    vi.advanceTimersByTime(INTERVAL);
    expect(socket.calls.pings).toBe(1);

    // The peer went away cleanly before answering. The readyState guard runs
    // before the awaitingPong check, so there is nothing left to terminate —
    // the socket's own "close" event owns the teardown.
    socket.readyState = 3;
    vi.advanceTimersByTime(INTERVAL * 5);

    expect(socket.calls.terminates).toBe(0);
  });

  it("honors a custom intervalMs", () => {
    const socket = fakeSocket();
    const heartbeat = createHeartbeat(socket, { intervalMs: 1_000 });

    vi.advanceTimersByTime(1_000);

    expect(socket.calls.pings).toBe(1);

    heartbeat.stop();
  });
});
