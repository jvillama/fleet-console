import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
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
}));

import * as dockerApi from "../src/docker.js";
import { buildApp } from "../src/app.js";
import { queryEvents } from "../src/audit.js";
import { loginAs } from "./helpers.js";

const mocked = vi.mocked(dockerApi);

let app: FastifyInstance;
let cookies: { session: string };

beforeEach(async () => {
  vi.resetAllMocks();
  app = await buildApp();
  cookies = await loginAs(app);
});

afterEach(async () => {
  await app.close();
});

function mockLogStream() {
  const stream = new PassThrough();
  const close = vi.fn(() => stream.destroy());
  mocked.streamContainerLogs.mockResolvedValue({ stream, close });
  return { stream, close };
}

/**
 * Opens a log stream as an arbitrary session. The cap is per user, so a
 * test that needs a second user calls this directly; openSocket wraps it
 * for the common case of the session beforeEach logged in.
 */
function openSocketAs(
  session: string,
  id: string,
  extraHeaders: Record<string, string> = {},
) {
  // cookies.session is the *decoded* value (set-cookie-parser undoes the
  // percent-encoding @fastify/cookie applies on the wire); injectWS's raw
  // headers option doesn't re-encode for us the way app.inject({ cookies })
  // does, so we must encode it ourselves to survive the Cookie header's
  // own ";"-separated parsing (secure-session's cipher;nonce value contains
  // a literal ";").
  return app.injectWS(`/api/logs/${id}`, {
    headers: {
      cookie: `session=${encodeURIComponent(session)}`,
      ...extraHeaders,
    },
    // A real upgrade gets req.socket for free from Node's HTTP server;
    // injectWS's fake request doesn't set one, and request.ip (used by the
    // audit call) reads raw.socket.remoteAddress under trustProxy — supply
    // it so the handler runs the same way it would in production.
    socket: { remoteAddress: "127.0.0.1" } as import("node:net").Socket,
  });
}

function openSocket(id = "abc123", extraHeaders: Record<string, string> = {}) {
  return openSocketAs(cookies.session, id, extraHeaders);
}

/**
 * A fresh PassThrough per call, unlike mockLogStream's single shared one:
 * these tests hold several streams open at once, and closing one socket
 * must not destroy another's source.
 */
function mockLogStreamPerCall(): PassThrough[] {
  const streams: PassThrough[] = [];
  mocked.streamContainerLogs.mockImplementation(() => {
    const stream = new PassThrough();
    streams.push(stream);
    return Promise.resolve({ stream, close: () => void stream.destroy() });
  });
  return streams;
}

/** Opens `count` streams for the logged-in user, ids c0…c(count-1). */
async function openMany(count: number) {
  const sockets: Awaited<ReturnType<typeof openSocket>>[] = [];
  for (let i = 0; i < count; i += 1) sockets.push(await openSocket(`c${i}`));
  return sockets;
}

function onClose(ws: Awaited<ReturnType<typeof openSocket>>) {
  return new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
}

function auditPage() {
  return queryEvents({ limit: 10, offset: 0, action: "container.logs" });
}

describe("GET /api/logs/:id (websocket)", () => {
  it("rejects an unauthenticated upgrade and writes no audit row", async () => {
    mockLogStream();

    await expect(app.injectWS("/api/logs/abc123")).rejects.toThrow();

    expect(auditPage().total).toBe(0);
    expect(mocked.streamContainerLogs).not.toHaveBeenCalled();
  });

  it("closes 1008 on an invalid id without touching Docker", async () => {
    mockLogStream();

    const ws = await openSocket("bad$id");
    const closed = await onClose(ws);

    expect(closed).toEqual({ code: 1008, reason: "Invalid container id" });
    expect(mocked.streamContainerLogs).not.toHaveBeenCalled();
    expect(auditPage().total).toBe(0);
  });

  it("closes 1008 on a cross-origin upgrade, audits it, docker untouched", async () => {
    mockLogStream();

    const ws = await openSocket("abc123", { origin: "http://evil.example" });
    const closed = await onClose(ws);

    expect(closed).toEqual({ code: 1008, reason: "Origin not allowed" });
    expect(mocked.streamContainerLogs).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(auditPage().total).toBe(1));
    expect(auditPage().events[0]).toMatchObject({
      actor: "alice",
      action: "container.logs",
      outcome: "failure",
      detail: "cross-origin websocket rejected: http://evil.example",
    });
  });

  it("closes 1008 on a malformed Origin header", async () => {
    mockLogStream();

    const ws = await openSocket("abc123", { origin: "not-a-url" });
    const closed = await onClose(ws);

    expect(closed).toEqual({ code: 1008, reason: "Origin not allowed" });
    expect(mocked.streamContainerLogs).not.toHaveBeenCalled();
  });

  it("allows a same-origin upgrade", async () => {
    mockLogStream();

    const ws = await openSocket("abc123", {
      host: "console.test",
      origin: "http://console.test",
    });
    await vi.waitFor(() => expect(auditPage().total).toBe(1));

    expect(auditPage().events[0]).toMatchObject({ outcome: "success" });
    ws.close();
  });

  it("audits the stream open with actor, target, and ip", async () => {
    mockLogStream();

    const ws = await openSocket();
    await vi.waitFor(() => expect(auditPage().total).toBe(1));

    expect(auditPage().events[0]).toMatchObject({
      actor: "alice",
      role: "admin",
      action: "container.logs",
      target: "abc123",
      outcome: "success",
    });
    expect(auditPage().events[0]?.ip).toBeTruthy();
    ws.close();
  });

  it("forwards log chunks as one text frame per line", async () => {
    const { stream } = mockLogStream();
    const ws = await openSocket();
    const messages: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- ws types RawData as Buffer | ArrayBuffer | Buffer[], but src/routes/logs.ts only ever socket.send()s strings, so frames always arrive as Buffer here.
    ws.on("message", (data) => messages.push(data.toString()));

    stream.write("first line\nsecond ");
    stream.write("line\n");

    await vi.waitFor(() =>
      expect(messages).toEqual(["first line", "second line"]),
    );
    ws.close();
  });

  it("strips trailing carriage returns and truncates monster lines", async () => {
    const { stream } = mockLogStream();
    const ws = await openSocket();
    const messages: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- ws types RawData as Buffer | ArrayBuffer | Buffer[], but src/routes/logs.ts only ever socket.send()s strings, so frames always arrive as Buffer here.
    ws.on("message", (data) => messages.push(data.toString()));

    stream.write("crlf line\r\n");
    stream.write(`${"x".repeat(9000)}\n`);

    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[0]).toBe("crlf line");
    expect(messages[1]).toHaveLength(8192);
    ws.close();
  });

  it("flushes the partial tail and closes 1000 when the stream ends", async () => {
    const { stream } = mockLogStream();
    const ws = await openSocket();
    const messages: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- ws types RawData as Buffer | ArrayBuffer | Buffer[], but src/routes/logs.ts only ever socket.send()s strings, so frames always arrive as Buffer here.
    ws.on("message", (data) => messages.push(data.toString()));
    const closed = onClose(ws);

    stream.write("no trailing newline");
    stream.end();

    expect(await closed).toEqual({ code: 1000, reason: "stream ended" });
    expect(messages).toEqual(["no trailing newline"]);
  });

  it("closes 1011 with the message when the stream errors", async () => {
    const { stream } = mockLogStream();
    const ws = await openSocket();
    const closed = onClose(ws);
    await vi.waitFor(() => expect(auditPage().total).toBe(1)); // handler attached

    stream.destroy(new Error("daemon gone"));

    expect(await closed).toEqual({ code: 1011, reason: "daemon gone" });
  });

  it("closes 1011 and audits failure when the stream cannot open", async () => {
    mocked.streamContainerLogs.mockRejectedValue(new Error("no such container"));

    const ws = await openSocket("deadbeef");
    const closed = await onClose(ws);

    expect(closed).toEqual({ code: 1011, reason: "no such container" });
    expect(auditPage().events[0]).toMatchObject({
      target: "deadbeef",
      outcome: "failure",
    });
  });

  it("closes the docker stream when the client disconnects", async () => {
    const { close } = mockLogStream();
    const ws = await openSocket();
    await vi.waitFor(() => expect(auditPage().total).toBe(1)); // handler attached

    // NOTE: a graceful ws.close() from the client does not propagate a
    // 'close' event to the server side of @fastify/websocket's injectWS fake
    // socket pair (verified against @fastify/websocket@11.3.0 in isolation,
    // and against a real TCP-backed ws client/server, which DOES propagate
    // it — so this is a harness limitation, not a `ws` protocol issue). The
    // plugin's own README testing example closes test sockets with
    // .terminate() rather than .close() for the same reason; .terminate()
    // reliably fires the server-side close handler here.
    ws.terminate();

    await vi.waitFor(() => expect(close).toHaveBeenCalled());
  });
});

describe("concurrent stream cap", () => {
  it("closes the sixth concurrent stream with 1013 without touching Docker", async () => {
    mockLogStreamPerCall();
    await openMany(5);
    expect(mocked.streamContainerLogs).toHaveBeenCalledTimes(5);

    const closed = await onClose(await openSocket("c5"));

    expect(closed).toEqual({
      code: 1013,
      reason: "Too many concurrent log streams (max 5)",
    });
    expect(mocked.streamContainerLogs).toHaveBeenCalledTimes(5);
  });

  it("audits the rejected stream as a failure", async () => {
    mockLogStreamPerCall();
    await openMany(5);

    await onClose(await openSocket("c5"));

    await vi.waitFor(() => expect(auditPage().total).toBe(6));
    const failures = auditPage().events.filter((e) => e.outcome === "failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      actor: "alice",
      action: "container.logs",
      outcome: "failure",
      target: "c5",
      detail: "concurrent log stream limit reached (5)",
    });
  });

  it("admits a new stream once an open one closes", async () => {
    const streams = mockLogStreamPerCall();
    const sockets = await openMany(5);

    // .close() (graceful) doesn't propagate a server-side "close" event in
    // this fake socket pair (see the note on "closes the docker stream when
    // the client disconnects" above); .terminate() does.
    sockets[0]?.terminate();
    // The route registers release() on the server socket's "close" before
    // the listener that calls logs.close(), so once the first source is
    // destroyed the slot is already free.
    await vi.waitFor(() => expect(streams[0]?.destroyed).toBe(true));

    await openSocket("c5");

    expect(mocked.streamContainerLogs).toHaveBeenCalledTimes(6);
  });

  it("caps each user separately", async () => {
    mockLogStreamPerCall();
    await openMany(5);
    expect((await onClose(await openSocket("c5"))).code).toBe(1013);

    const bob = await loginAs(app, "bob", "battery staple");
    await openSocketAs(bob.session, "c9");

    expect(mocked.streamContainerLogs).toHaveBeenCalledTimes(6);
  });

  it("frees the slot when the stream fails to open", async () => {
    mockLogStreamPerCall();
    await openMany(4);
    mocked.streamContainerLogs.mockRejectedValueOnce(new Error("boom"));

    await onClose(await openSocket("c4"));
    await openSocket("c5");

    expect(mocked.streamContainerLogs).toHaveBeenCalledTimes(6);
  });
});
