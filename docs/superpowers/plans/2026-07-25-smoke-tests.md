# Deployment Smoke Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A gating CI job that boots the real compose stack and proves the
proxy-dependent critical path works, including that log frames actually
flow over the WebSocket.

**Architecture:** One dependency-free Node script (`scripts/smoke.mjs`)
making four assertions against a running stack, a committed `.env.smoke`
fixture supplying throwaway credentials, and a `smoke` job in `ci.yml` that
builds the stack with compose, runs the script, and gates image publishing.
No changes to `server/` or `web/` source.

**Tech Stack:** Node 22 (`node:http`, no npm dependencies), Docker Compose,
GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-25-smoke-tests-design.md`

## Global Constraints

- **`scripts/smoke.mjs` must have zero npm dependencies.** It runs as `node scripts/smoke.mjs` from the repo root, matching `scripts/sync-types.mjs`. Do not add a root `package.json`, do not import from `server/node_modules`, do not add a `smoke/` package.
- **Do not use Node's global `WebSocket`.** It follows the browser API and cannot set `Cookie` or `Origin` — the two headers this test exists to exercise. Use `node:http`'s `upgrade` event against the raw socket.
- **The load-bearing assertion is the first WS frame's opcode**: `opcode = firstByte & 0x0f`; `0x1` (text) passes, `0x8` (close) fails. HTTP 101 alone proves nothing — `@fastify/websocket` completes the handshake before the route handler runs, so the 11-day outage returned 101 and *then* a 1008 close frame.
- Config comes from `SMOKE_BASE_URL` (default `http://localhost:8080`), `SMOKE_USER` (default `smoke`), `SMOKE_PASSWORD` (default `smoke-test-password`).
- The stream target is the container whose name contains `demo-redis` — it emits ~5 KB of startup output immediately. Never use `demo-nginx`; it can stay silent until it receives a request.
- Do not modify anything under `server/src/`, `server/test/`, `web/src/`, or `web/nginx.conf` **except** the temporary revert in Task 4, which must be restored before that task's commit.
- Never run `npm install` in either package. Local npm is 11.x and rewrites lockfiles in a way CI's npm 10 rejects. This plan requires no installs at all.
- Every step's commands run from the repo root (`C:\Users\Owner\Repos\fleet-console`) unless stated otherwise.

---

### Task 1: The smoke script

The whole deliverable except CI wiring. Ends with the script passing against the stack already running on this machine.

**Files:**
- Create: `scripts/smoke.mjs`
- Create: `.env.smoke`

**Interfaces:**
- Consumes: nothing.
- Produces: `node scripts/smoke.mjs` — exits `0` on success, `1` on first failure, printing one `ok:`/`FAIL:` line per step. Task 3 invokes it from CI; Task 4 uses it as the detector.

- [ ] **Step 1: Generate the fixture password hash**

Run, from `server/`:

```bash
npm run hash-password -- "smoke-test-password"
```

Copy the printed `scrypt:<salt>:<hash>` value — Step 2 embeds it. It is
random per run, so do not reuse a hash from anywhere else.

- [ ] **Step 2: Write the `.env.smoke` fixture**

Create `.env.smoke` at the repo root, substituting the hash from Step 1 for
`<PASTE_HASH_FROM_STEP_1>`. Keep `FLEET_USERS` on one line — the parsers do
not handle multi-line values.

```bash
# CI FIXTURE — NOT A TEMPLATE. Do not copy this to .env.
#
# Credentials for the ephemeral stack the `smoke` CI job builds, runs for
# about 90 seconds, and destroys. The stack is never network-reachable and
# this account has no access to anything else. A real deployment must
# generate its own secret and password hash; see README "Authentication &
# audit log".
#
# Password for FLEET_USERS below is: smoke-test-password
FLEET_SESSION_SECRET="smoke-only-session-secret-not-for-real-use"
FLEET_USERS=[{"username":"smoke","role":"admin","passwordHash":"<PASTE_HASH_FROM_STEP_1>"}]
```

- [ ] **Step 3: Write the smoke script**

Create `scripts/smoke.mjs`:

```js
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
```

- [ ] **Step 4: Run it against the stack already running on this machine**

A compose stack is already up on this machine from earlier work, but it
uses the developer's own `.env`, not the fixture. Point the script at those
credentials by reading the username from the running container and asking
the operator for nothing — instead, restart the stack on the fixture:

```bash
cp .env .env.developer-backup
cp .env.smoke .env
docker compose up -d --build
```

Wait for health, then run:

```bash
until curl -sf http://localhost:8080/api/health > /dev/null; do sleep 2; done
node scripts/smoke.mjs
```

Expected: four `ok:` lines then `smoke: all 4 checks passed`, exit 0.

If step 4 reports a CLOSE frame here, the stack is genuinely broken — stop
and report, do not adjust the script to pass.

- [ ] **Step 5: Restore the developer's env**

```bash
cp .env.developer-backup .env && rm .env.developer-backup
docker compose up -d --build
```

Confirm `git status --short` shows only the two new files (`.env` is
gitignored; `.env.developer-backup` must be gone).

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke.mjs .env.smoke
git commit -m "test: add a deployment smoke script"
```

---

### Task 2: Wire it into CI

**Files:**
- Modify: `.github/workflows/ci.yml` (add a `smoke` job; add `smoke` to the `images` job's `needs` at line 73)

**Interfaces:**
- Consumes: `node scripts/smoke.mjs` and `.env.smoke` from Task 1.
- Produces: a required `smoke` check on every PR, and `images` gated on it.

- [ ] **Step 1: Add the `smoke` job**

In `.github/workflows/ci.yml`, insert this job after the `contract` job
(which ends at line 63) and before the `images` comment block:

```yaml
  # Boots the real compose stack and exercises the proxy-dependent critical
  # path. The unit suites cover each package in isolation; nothing else in
  # this workflow ever RUNS what it builds, which is how a broken
  # nginx Host header left log streaming dead for 11 days with every check
  # green. See docs/superpowers/specs/2026-07-25-smoke-tests-design.md.
  smoke:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - name: Start the stack on the CI fixture credentials
        run: |
          cp .env.smoke .env
          docker compose up -d --build
      - name: Wait for the API to report healthy
        run: |
          for i in $(seq 1 30); do
            if curl -sf http://localhost:8080/api/health | grep -q '"ok":true'; then
              echo "healthy after ${i} attempts"
              exit 0
            fi
            sleep 2
          done
          echo "stack did not become healthy within 60s"
          exit 1
      - name: Run the smoke checks
        run: node scripts/smoke.mjs
      - name: Dump stack logs on failure
        if: failure()
        run: docker compose logs --no-color --tail 200
      - name: Tear down
        if: always()
        run: docker compose down -v
```

The health gate greps for `"ok":true` rather than accepting any 200:
`/api/health` returns `ok: false` when the Docker socket is unreachable,
which would otherwise surface as a confusing failure at check 3.

- [ ] **Step 2: Gate image publishing on smoke**

In the same file, change the `images` job's `needs` (line 73) from:

```yaml
    needs: [server, web, contract]
```

to:

```yaml
    needs: [server, web, contract, smoke]
```

A stack that fails smoke must never publish to GHCR.

- [ ] **Step 3: Validate the workflow parses**

Run:

```bash
node -e "const {readFileSync}=require('fs');const s=readFileSync('.github/workflows/ci.yml','utf8');if(!/^  smoke:$/m.test(s))throw new Error('smoke job not found');if(!/needs: \[server, web, contract, smoke\]/.test(s))throw new Error('images needs not updated');console.log('ci.yml wiring looks right')"
```

Expected: `ci.yml wiring looks right`.

There is no local GitHub Actions runner here; the real validation is the
job running on the PR in Task 4.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: gate merges and image publishing on a stack smoke test"
```

---

### Task 3: Docs

**Files:**
- Modify: `README.md` (testing section)
- Modify: `CLAUDE.md` (Commands section, and the proxy gotcha added in commit `e8de878`)

**Interfaces:**
- Consumes: `node scripts/smoke.mjs` from Task 1.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Find the README testing section**

Run:

```bash
grep -n "npm test\|Testing\|## Development" README.md | head -10
```

Note the line number of the testing/development prose — Step 2 adds a
paragraph immediately after it.

- [ ] **Step 2: Add the README paragraph**

Insert after the testing prose located in Step 1:

```markdown
### Smoke tests

`server/` and `web/` are unit-tested in isolation, which leaves the
assembled product — nginx's SPA fallback, `/api` forwarding, session-cookie
passthrough, and the WebSocket upgrade — untested. `scripts/smoke.mjs`
covers that seam against a running stack:

```bash
cp .env.smoke .env && docker compose up -d --build
node scripts/smoke.mjs
```

It checks that the SPA is served, that login sets a session cookie through
the proxy, that the API lists the demo fleet, and that the log stream
delivers a real text frame rather than an immediate close. Override
`SMOKE_BASE_URL`, `SMOKE_USER`, and `SMOKE_PASSWORD` to point it at another
stack. CI runs this on every PR and blocks image publishing on it.
```

- [ ] **Step 3: Add the CLAUDE.md command line**

In `CLAUDE.md`, in the "Commands (run inside each package)" list, add as
the last bullet:

```markdown
- `node scripts/smoke.mjs` — from the repo root, against a running stack: the only test covering the assembled product (nginx + server + WS). CI's `smoke` job runs it on every PR and gates image publishing.
```

- [ ] **Step 4: Extend the proxy gotcha**

In `CLAUDE.md`, find the bullet beginning `- **The proxies must forward the
browser's real \`Host\`, port included.**` and append this sentence to the
end of that same bullet:

```
`scripts/smoke.mjs` is the only automated check on this: its fourth assertion reads the first WebSocket frame's opcode, because a rejected stream still returns HTTP 101 and only then sends a 1008 close — so asserting the handshake succeeded proves nothing.
```

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document the smoke script and what it covers"
```

---

### Task 4: Prove it catches the real bug

The spec calls this mandatory: a smoke test that cannot detect the outage it was built for is worthless. This task deliberately reintroduces the bug, confirms the script fails, and restores.

**Files:**
- Temporarily modify then restore: `web/nginx.conf` (the `proxy_set_header Host` line)
- No file is left changed by this task. Its deliverable is recorded evidence.

**Interfaces:**
- Consumes: `node scripts/smoke.mjs` from Task 1.
- Produces: the RED/GREEN evidence pasted into the task report.

- [ ] **Step 1: Put the stack on fixture credentials**

```bash
cp .env .env.developer-backup
cp .env.smoke .env
```

- [ ] **Step 2: Reintroduce the outage**

In `web/nginx.conf`, change the line reading:

```
        proxy_set_header Host $http_host;
```

to:

```
        proxy_set_header Host $host;
```

Leave the explanatory comment above it untouched.

- [ ] **Step 3: Rebuild and run — the script MUST fail**

```bash
docker compose up -d --build web
until curl -sf http://localhost:8080/api/health > /dev/null; do sleep 2; done
node scripts/smoke.mjs; echo "exit=$?"
```

Expected: checks 1–3 print `ok:`, then:

```
FAIL: WS /api/logs/:id
      first frame was a CLOSE frame, not log data — ...
exit=1
```

Capture this output verbatim for the report. **If the script passes here,
stop and report BLOCKED** — the test does not detect the bug it exists to
catch, and shipping it would be worse than shipping nothing.

- [ ] **Step 4: Restore the fix**

Revert `web/nginx.conf` to `proxy_set_header Host $http_host;`. Confirm with:

```bash
git diff --stat web/nginx.conf
```

Expected: no output (file matches HEAD).

- [ ] **Step 5: Rebuild and run — the script MUST pass**

```bash
docker compose up -d --build web
until curl -sf http://localhost:8080/api/health > /dev/null; do sleep 2; done
node scripts/smoke.mjs; echo "exit=$?"
```

Expected: four `ok:` lines, `smoke: all 4 checks passed`, `exit=0`. Capture
verbatim for the report.

- [ ] **Step 6: Restore the developer's env and confirm the tree is clean**

```bash
cp .env.developer-backup .env && rm .env.developer-backup
docker compose up -d --build
git status --short
```

Expected: `git status --short` is empty. Nothing in this task gets
committed — the evidence lives in the task report.

---

## Verification

After all four tasks:

```bash
git status --short          # must be empty
node scripts/smoke.mjs      # must exit 0 against the running stack
cd server && npm test       # 207/207, unaffected by this work
cd ../web && npm test       # 62/62, unaffected by this work
```

The `smoke` job itself can only be verified on the PR — no local runner
exists. Watch it on the first CI run and confirm it passes there before
merging.
