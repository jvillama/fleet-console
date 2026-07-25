import { describe, expect, it } from "vitest";
import { createSendGate } from "../src/routes/logs.js";

const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;

/**
 * The slice of a ws WebSocket the gate touches. `bufferedAmount` is
 * writable here so a test can simulate a client falling behind and
 * catching up; the real socket updates it as frames drain.
 */
function fakeSocket() {
  const sent: string[] = [];
  return {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    send: (data: string) => void sent.push(data),
    sent,
  };
}

describe("createSendGate", () => {
  it("forwards lines untouched while the queue is clear", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    gate.send("first");
    gate.send("second");

    expect(socket.sent).toEqual(["first", "second"]);
  });

  it("sends nothing when the socket is not OPEN", () => {
    const socket = fakeSocket();
    socket.readyState = 3; // CLOSED
    const gate = createSendGate(socket);

    gate.send("dropped on the floor");

    expect(socket.sent).toEqual([]);
  });

  it("suppresses and counts once the queue passes the high-water mark", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    socket.bufferedAmount = HIGH_WATER + 1;
    gate.send("one");
    gate.send("two");

    expect(socket.sent).toEqual([]);
  });

  it("suppresses at exactly the high-water mark", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    socket.bufferedAmount = HIGH_WATER;
    gate.send("right at the mark");

    expect(socket.sent).toEqual([]);
  });

  it("stays suppressed while the queue sits between the marks", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    socket.bufferedAmount = HIGH_WATER + 1;
    gate.send("dropped");
    // Drained below high water but not below low water: still suppressed,
    // otherwise a client hovering here emits a notice on nearly every line.
    socket.bufferedAmount = LOW_WATER + 1;
    gate.send("also dropped");

    expect(socket.sent).toEqual([]);
  });

  it("emits one accurate notice before the resumed line, then resets", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    socket.bufferedAmount = HIGH_WATER + 1;
    gate.send("a");
    gate.send("b");
    gate.send("c");
    socket.bufferedAmount = 0;
    gate.send("resumed");
    gate.send("after");

    expect(socket.sent).toEqual([
      "⚠ 3 lines dropped (slow client)",
      "resumed",
      "after",
    ]);
  });

  it("emits no notice when nothing was dropped", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    socket.bufferedAmount = LOW_WATER + 1; // busy, but never suppressed
    gate.send("still fine");

    expect(socket.sent).toEqual(["still fine"]);
  });

  it("finish() reports a pending count even with a deep queue", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    socket.bufferedAmount = HIGH_WATER + 1;
    gate.send("a");
    gate.send("b");
    gate.finish();

    expect(socket.sent).toEqual(["⚠ 2 lines dropped (slow client)"]);
  });

  it("finish() is a no-op when nothing was dropped", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    gate.send("all delivered");
    gate.finish();

    expect(socket.sent).toEqual(["all delivered"]);
  });

  it("finish() is silent when the socket is not OPEN", () => {
    const socket = fakeSocket();
    const gate = createSendGate(socket);

    socket.bufferedAmount = HIGH_WATER + 1;
    gate.send("dropped");
    socket.readyState = 3; // CLOSED
    gate.finish();

    expect(socket.sent).toEqual([]);
  });
});
