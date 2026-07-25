#!/usr/bin/env node
// Deployment smoke test: proves the assembled stack works, which no unit
// test in either package can. Every assertion here can only break at the
// proxy seam — SPA fallback, /api forwarding, cookie passthrough, and the
// WebSocket upgrade. Run against any stack: node scripts/smoke.mjs
//
// Dependency-free on purpose (see scripts/sync-types.mjs for the same
// pattern): the CI job needs no npm ci at all.
import http from "node:http";
import { randomBytes } from "node:crypto";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:8080";
const USER = process.env.SMOKE_USER ?? "smoke";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "smoke-test-password";

const { hostname, port } = new URL(BASE);
const PORT = port || "80";

function fail(step, detail) {
  console.error(`FAIL: ${step}\n      ${detail}`);
  process.exit(1);
}

function ok(step, detail) {
  console.log(`ok: ${step}${detail ? ` — ${detail}` : ""}`);
}

/** Plain HTTP request. Resolves { status, headers, body }. */
function request(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname, port: PORT, path, method, headers: { origin: BASE, ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Opens the log stream and resolves the first frame's opcode.
 *
 * Reading the raw socket rather than using a WebSocket client is the point:
 * @fastify/websocket completes the handshake BEFORE the route handler runs,
 * so a rejected stream still returns 101 and only then sends a 1008 close
 * frame. Asserting 101 would have passed throughout the 11-day outage this
 * test exists to catch. Only the opcode nibble and payload length are
 * parsed — server frames are unmasked and the decoded text is not needed.
 */
function openLogStream(id, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname,
      port: PORT,
      path: `/api/logs/${id}`,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        // Must decode to exactly 16 bytes — ws validates this and rejects
        // a handshake whose key is the wrong length.
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
        origin: BASE,
        cookie,
      },
    });

    const timer = setTimeout(
      () => reject(new Error("no WebSocket frame within 10s")),
      10_000,
    );

    req.on("upgrade", (res, socket) => {
      if (res.statusCode !== 101) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`upgrade returned ${res.statusCode}, expected 101`));
        return;
      }
      socket.once("data", (buf) => {
        clearTimeout(timer);
        socket.destroy();
        // Deliberately not decoding the payload length header: a log line
        // over 125 bytes switches to the extended-length encoding, and the
        // raw byte count answers "did content arrive" without that branch.
        resolve({ opcode: buf[0] & 0x0f, bytes: buf.length, raw: buf });
      });
    });
    req.on("response", (res) => {
      clearTimeout(timer);
      reject(new Error(`no upgrade; server answered HTTP ${res.statusCode}`));
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

const overall = setTimeout(() => fail("overall", "smoke run exceeded 30s"), 30_000);

// 1. SPA is served (nginx try_files fallback).
const root = await request("/");
if (root.status !== 200) fail("GET /", `status ${root.status}, expected 200`);
if (!root.body.includes('<div id="root">')) {
  fail("GET /", "response body is not the SPA shell");
}
ok("GET / serves the SPA");

// 2. Login through the proxy sets a session cookie.
const payload = JSON.stringify({ username: USER, password: PASSWORD });
const login = await request("/api/login", {
  method: "POST",
  headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
  body: payload,
});
if (login.status !== 200) {
  fail("POST /api/login", `status ${login.status}, body ${login.body.slice(0, 200)}`);
}
const setCookie = (login.headers["set-cookie"] ?? []).find((c) => c.startsWith("session="));
if (!setCookie) fail("POST /api/login", "no session cookie in set-cookie");
const cookie = setCookie.split(";")[0];
ok("POST /api/login sets a session cookie");

// 3. Authed API returns the demo fleet (proves the Docker socket mount).
const list = await request("/api/containers", { headers: { cookie } });
if (list.status !== 200) fail("GET /api/containers", `status ${list.status}`);
const containers = JSON.parse(list.body);
if (!Array.isArray(containers)) fail("GET /api/containers", "body is not an array");
const target = containers.find((c) => c.name.includes("demo-redis"));
if (!target) {
  fail(
    "GET /api/containers",
    `no demo-redis container; saw ${containers.map((c) => c.name).join(", ") || "none"}`,
  );
}
ok("GET /api/containers lists the demo fleet", `${containers.length} containers`);

// 4. Log frames actually flow. THE assertion — see openLogStream.
let frame;
try {
  frame = await openLogStream(target.id, cookie);
} catch (err) {
  fail("WS /api/logs/:id", err.message);
}
if (frame.opcode === 0x8) {
  fail(
    "WS /api/logs/:id",
    "first frame was a CLOSE frame, not log data — the server accepted the " +
      "upgrade and then rejected the stream. Check the proxy's Host header " +
      "(nginx must send $http_host, not $host) and the origin check in " +
      "server/src/routes/logs.ts.",
  );
}
if (frame.opcode !== 0x1) {
  fail("WS /api/logs/:id", `first frame opcode was 0x${frame.opcode.toString(16)}, expected 0x1 (text)`);
}
if (frame.bytes <= 2) fail("WS /api/logs/:id", "first text frame carried no payload");
ok("WS /api/logs/:id streams log data", `${frame.bytes}-byte first frame`);

clearTimeout(overall);
console.log("\nsmoke: all 4 checks passed");
process.exit(0);
