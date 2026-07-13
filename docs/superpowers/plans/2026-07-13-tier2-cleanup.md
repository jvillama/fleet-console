# Tier 2 Deferred-Backlog Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four Tier 2 follow-ups recorded by past branch reviews: WS Origin check on the logs route, consistent audit target naming (deploy records container *name* like rollback does), visibility + cleanup for parked `-predeploy-N` containers, and surfacing server error detail in web UI error messages.

**Architecture:** Three server-side changes (logs route guard, audit target rewrite on deploy accept, deploy-pipeline detail/cleanup) plus one web change (the shared `request()` wrapper reads the `ApiError` body). No API contract changes — `ApiError.detail` already exists in `server/src/types.ts`, so `web/src/types.ts` stays untouched and `sync-types` stays clean.

**Tech Stack:** Fastify 5 + dockerode (mocked in tests), better-sqlite3, Vitest; React 18 + Vite, Vitest + React Testing Library.

## Global Constraints

- Two independent npm packages: run npm commands inside `server/` or `web/`, never at the root.
- Server uses NodeNext resolution: relative imports end in `.js` (e.g. `./docker.js`). Web uses extensionless imports.
- `server/src/docker.ts` is the only module that touches dockerode; `server/src/db.ts` the only one touching better-sqlite3.
- Audit policy: mutating routes fail CLOSED (insert-then-update); reads/auth fail OPEN. Do not weaken either.
- Per-container failures degrade to "—" in the UI instead of failing the whole response.
- `web/src/types.ts` is GENERATED — never hand-edit. This plan does not change `server/src/types.ts`, so no regeneration is needed; verify with `node scripts/sync-types.mjs --check`.
- Commit messages: no `Co-Authored-By` trailer (project preference).
- No new dependencies; no lockfile changes.
- Branch: `tier2-cleanup` off `main`.

---

### Task 1: WebSocket Origin check on the logs route

Cross-Site WebSocket Hijacking guard, recorded as a defense-in-depth follow-up by the log-streaming final review. Browsers always send an `Origin` header on WS handshakes; `SameSite=Strict` already keeps the session cookie off cross-site upgrades, so this is belt-and-braces. Requests **without** an Origin header (curl, wscat, injectWS tests, the deploy workflow) must keep working.

**Files:**
- Modify: `server/src/routes/logs.ts`
- Test: `server/test/logs-routes.test.ts`

**Interfaces:**
- Consumes: `auditFailOpen` (already imported in logs.ts), `request.headers.origin` / `request.headers.host`.
- Produces: nothing used by later tasks.

- [ ] **Step 1: Extend the `openSocket` test helper to accept extra headers**

In `server/test/logs-routes.test.ts`, change the helper (currently `function openSocket(id = "abc123")`) to:

```ts
function openSocket(id = "abc123", extraHeaders: Record<string, string> = {}) {
  // cookies.session is the *decoded* value (set-cookie-parser undoes the
  // percent-encoding @fastify/cookie applies on the wire); injectWS's raw
  // headers option doesn't re-encode for us the way app.inject({ cookies })
  // does, so we must encode it ourselves to survive the Cookie header's
  // own ";"-separated parsing (secure-session's cipher;nonce value contains
  // a literal ";").
  return app.injectWS(`/api/logs/${id}`, {
    headers: {
      cookie: `session=${encodeURIComponent(cookies.session)}`,
      ...extraHeaders,
    },
    // A real upgrade gets req.socket for free from Node's HTTP server;
    // injectWS's fake request doesn't set one, and request.ip (used by the
    // audit call) reads raw.socket.remoteAddress under trustProxy — supply
    // it so the handler runs the same way it would in production.
    socket: { remoteAddress: "127.0.0.1" } as import("node:net").Socket,
  });
}
```

- [ ] **Step 2: Write the failing tests**

Append inside the existing `describe("GET /api/logs/:id (websocket)")` block:

```ts
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
```

(Existing tests send no Origin header at all, so they double as the "non-browser clients pass" coverage.)

- [ ] **Step 3: Run the tests to verify they fail**

Run (inside `server/`): `npx vitest run test/logs-routes.test.ts`
Expected: the two new 1008 tests FAIL (socket streams instead of closing with "Origin not allowed"); same-origin test passes vacuously.

- [ ] **Step 4: Implement the guard**

In `server/src/routes/logs.ts`, add below `closeReason`:

```ts
/**
 * Cross-Site WebSocket Hijacking guard. Browsers always send Origin on a
 * WS handshake; SameSite=Strict already keeps the session cookie off
 * cross-site upgrades, so this is defense-in-depth. Requests without an
 * Origin header (curl, wscat, tests) pass — they are not browsers and
 * cannot ride a victim's cookie jar.
 */
export function sameOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (origin === undefined) return true;
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
```

In the route handler, after `const user = request.session.get("user");` and before the `streamContainerLogs` try-block, insert:

```ts
      if (!sameOrigin(request.headers.origin, request.headers.host)) {
        auditFailOpen(request, {
          actor: user?.username ?? "unknown",
          role: user?.role ?? null,
          action: "container.logs",
          outcome: "failure",
          target: id,
          ip: request.ip,
          detail: `cross-origin websocket rejected: ${request.headers.origin ?? ""}`.slice(0, 200),
        });
        socket.close(1008, "Origin not allowed");
        return;
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (inside `server/`): `npx vitest run test/logs-routes.test.ts`
Expected: PASS, all tests in the file (previous tests unaffected — they send no Origin).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/logs.ts server/test/logs-routes.test.ts
git commit -m "feat: reject cross-origin WebSocket upgrades on the logs route"
```

---

### Task 2: Deploy audit rows record the container name, like rollback

Recorded follow-up: deploy audits `target = <url param>` (id or name, whatever the client sent) while rollback audits the container *name*. Deployment history and the single-flight guard key on name — the stable identity across recreates — so pin the audit row to the name once the engine has resolved it. The row is still inserted fail-closed *before* any Docker access; the target rewrite happens after the pipeline is accepted and fails OPEN (the row itself is intact, the pipeline is already running).

**Files:**
- Modify: `server/src/audit.ts`
- Modify: `server/src/deploy.ts` (ok-outcome gains `containerName`)
- Modify: `server/src/routes/deployments.ts` (deploy handler rewrites the target)
- Test: `server/test/audit.test.ts`, `server/test/deploy.test.ts`, `server/test/deployments-routes.test.ts`

**Interfaces:**
- Produces: `updateEventTarget(id: number, target: string): void` in `audit.ts` (throws when the row does not exist, same as `updateEventOutcome`).
- Produces: `DeployRequestOutcome` ok variant becomes `{ ok: true; deploymentId: number; containerName: string }` — Task 3 leaves this untouched but its diffs assume it.

- [ ] **Step 1: Write the failing tests**

In `server/test/audit.test.ts`, add (import `updateEventTarget` alongside the existing audit imports; follow the file's existing setup — it already inits an in-memory DB):

```ts
describe("updateEventTarget", () => {
  it("rewrites the target of an existing event", () => {
    const id = recordEvent({
      actor: "alice",
      role: "admin",
      action: "container.deploy",
      target: "oldid123",
      outcome: "failure",
    });

    updateEventTarget(id, "web-1");

    const [event] = queryEvents({ limit: 1, offset: 0 }).events;
    expect(event).toMatchObject({ id, target: "web-1" });
  });

  it("throws when the event does not exist", () => {
    expect(() => updateEventTarget(99999, "web-1")).toThrow("not found");
  });
});
```

In `server/test/deployments-routes.test.ts`, update the happy-path deploy test (`"202 for admins; ..."`): change the expectation `target: "oldid123"` to `target: "web-1"` — the deploy was requested by container id, but the settled audit row must carry the name. Also extend the 404 test (`"404 when the container does not exist..."`) to pin the fallback: add `target: "oldid123"` to its `toMatchObject` — when the container can't be resolved, the row keeps whatever the client sent.

In `server/test/deploy.test.ts`, update the happy-path equality check in `"runs to succeeded, records ids and images, settles the audit row"`:

```ts
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest's expect.any() is typed `any`
    expect(result).toEqual({
      ok: true,
      deploymentId: expect.any(Number),
      containerName: "web-1",
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (inside `server/`): `npx vitest run test/audit.test.ts test/deploy.test.ts test/deployments-routes.test.ts`
Expected: FAIL — `updateEventTarget` is not exported; result has no `containerName`; route test sees `target: "oldid123"`.

- [ ] **Step 3: Implement**

In `server/src/audit.ts`, add below `updateEventOutcome`:

```ts
/**
 * Rewrites an event's target. Deploys audit fail-closed before the
 * container is inspected, so the row starts as whatever the client sent
 * (id or name); once the engine resolves the container, this pins the row
 * to the stable name — the identity rollback rows and deployment history
 * key on.
 */
export function updateEventTarget(id: number, target: string): void {
  const result = getDb()
    .prepare(`UPDATE audit_events SET target = ? WHERE id = ?`)
    .run(target, id);
  if (result.changes === 0) {
    throw new Error(`audit event ${id} not found`);
  }
}
```

In `server/src/deploy.ts`:

```ts
export type DeployRequestOutcome =
  | { ok: true; deploymentId: number; containerName: string }
  | { ok: false; code: 404 | 409 | 422 | 502; error: string };
```

and change the success return at the end of `requestDeploy` to:

```ts
  active.set(spec.name, deploymentId);
  void runPipeline(deploymentId, spec, newImage, p.auditId, p.log);
  return { ok: true, deploymentId, containerName: spec.name };
```

In `server/src/routes/deployments.ts`: import `updateEventTarget` from `../audit.js`, then in the **deploy** handler replace the tail after the `requestDeploy` call with:

```ts
      if (!result.ok) {
        settleAudit(request, auditId, "failure", result.error);
        const body: ApiError = { error: result.error };
        return reply.code(result.code).send(body);
      }
      // The row was inserted (fail-closed) before the container was
      // resolved, so its target is whatever the client sent — id or name.
      // Pin it to the stable name, the identity rollback rows and
      // deployment history key on. Fail open: the pipeline is already
      // running and the row itself is intact.
      try {
        updateEventTarget(auditId, result.containerName);
      } catch (err) {
        request.log.error({ err, auditId }, "audit target update failed");
      }
      const body: DeployAccepted = { deploymentId: result.deploymentId };
      return reply.code(202).send(body);
```

The rollback handler needs no change — it already inserts with `source.containerName`.

- [ ] **Step 4: Run the tests to verify they pass**

Run (inside `server/`): `npx vitest run test/audit.test.ts test/deploy.test.ts test/deployments-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/audit.ts server/src/deploy.ts server/src/routes/deployments.ts server/test/audit.test.ts server/test/deploy.test.ts server/test/deployments-routes.test.ts
git commit -m "fix: deploy audit rows record the container name, matching rollback"
```

---

### Task 3: Parked `-predeploy-N` containers — surface in detail, clean on rollback

Recorded follow-up: a health-failed deploy leaves the old (good) container parked as `<name>-predeploy-<deploymentId>` forever, silently. Two remedies: (a) failure detail names the parked container whenever one exists; (b) a *successful rollback* best-effort removes the parked container left by the deployment it rolls back (404 = nothing parked = the common case, silent). Success detail also notes when the normal parked-cleanup fails.

**Files:**
- Modify: `server/src/docker.ts` (export the parked-name helper)
- Modify: `server/src/deploy.ts` (`runPipeline`)
- Test: `server/test/deploy.test.ts`

**Interfaces:**
- Consumes: `DeployRequestOutcome` ok variant from Task 2 (`containerName` — untouched here).
- Produces: `parkedContainerName(name: string, deploymentId: number): string` exported from `docker.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `describe("requestDeploy — pipeline")` in `server/test/deploy.test.ts`:

```ts
  it("health failure names the parked old container in the detail", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());
    mocked.pullImage.mockResolvedValue(undefined);
    mocked.recreateContainer.mockResolvedValue("newid987");
    mocked.watchHealth.mockResolvedValue({
      healthy: false,
      reason: "container reported unhealthy",
    });

    const result = await requestDeploy(baseParams(auditRow()));
    if (!result.ok) throw new Error("expected ok");

    await waitForStatus(result.deploymentId, "failed");
    expect(getDeployment(result.deploymentId)?.detail).toBe(
      `container reported unhealthy; previous container parked as web-1-predeploy-${result.deploymentId}`,
    );
  });

  it("a failure before the recreate does not mention a parked container", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());
    mocked.pullImage.mockRejectedValue(new Error("manifest unknown"));
    mocked.imageExistsLocally.mockResolvedValue(false);

    const result = await requestDeploy(baseParams(auditRow()));
    if (!result.ok) throw new Error("expected ok");

    await waitForStatus(result.deploymentId, "failed");
    expect(getDeployment(result.deploymentId)?.detail).toBe("manifest unknown");
  });

  it("success detail notes when the parked container could not be removed", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());
    mocked.pullImage.mockResolvedValue(undefined);
    mocked.recreateContainer.mockResolvedValue("newid987");
    mocked.watchHealth.mockResolvedValue({ healthy: true });
    mocked.removeContainer.mockRejectedValue(new Error("device busy"));

    const result = await requestDeploy(baseParams(auditRow()));
    if (!result.ok) throw new Error("expected ok");

    await waitForStatus(result.deploymentId, "succeeded");
    expect(getDeployment(result.deploymentId)?.detail).toBe(
      `nginx:1.27 → nginx:1.28; parked container web-1-predeploy-${result.deploymentId} not removed`,
    );
  });

  it("a successful rollback removes the rolled-back deployment's parked container", async () => {
    happyMocks();

    const result = await requestDeploy({
      container: "oldid123",
      image: "nginx:1.26",
      rollbackOf: 41,
      actor: "alice",
      role: "admin",
      auditId: auditRow(),
      log,
    });
    if (!result.ok) throw new Error("expected ok");

    await waitForStatus(result.deploymentId, "succeeded");
    expect(mocked.removeContainer).toHaveBeenCalledWith("oldid123");
    expect(mocked.removeContainer).toHaveBeenCalledWith("web-1-predeploy-41");
  });

  it("rollback cleanup swallows 404 (nothing was parked) and keeps a clean detail", async () => {
    mocked.inspectForRecreate.mockResolvedValue(spec());
    mocked.pullImage.mockResolvedValue(undefined);
    mocked.recreateContainer.mockResolvedValue("newid987");
    mocked.watchHealth.mockResolvedValue({ healthy: true });
    mocked.removeContainer.mockImplementation((id: string) => {
      if (id === "web-1-predeploy-41") {
        return Promise.reject(
          Object.assign(new Error("no such container"), { statusCode: 404 }),
        );
      }
      return Promise.resolve(undefined);
    });

    const result = await requestDeploy({
      container: "oldid123",
      image: "nginx:1.26",
      rollbackOf: 41,
      actor: "alice",
      role: "admin",
      auditId: auditRow(),
      log,
    });
    if (!result.ok) throw new Error("expected ok");

    await waitForStatus(result.deploymentId, "succeeded");
    expect(getDeployment(result.deploymentId)?.detail).toBe("nginx:1.27 → nginx:1.26");
  });
```

Also update the pre-existing health-failure test (`"health failure fails the deployment but keeps the new container"`): its `detail: "container reported unhealthy"` expectation becomes stale. Change that assertion to use the result's id:

```ts
    expect(getDeployment(result.deploymentId)).toMatchObject({
      detail: `container reported unhealthy; previous container parked as web-1-predeploy-${result.deploymentId}`,
      newContainerId: "newid987",
    });
```

And add a trivial unit test for the helper (same file, top level next to `describe("parseImageRef")`):

```ts
describe("parkedContainerName", () => {
  it("matches the name recreateContainer parks under", () => {
    expect(parkedContainerName("web-1", 7)).toBe("web-1-predeploy-7");
  });
});
```

Note: this helper lives in `../src/docker.js`, which `deploy.test.ts` mocks — so this one describe block goes in `server/test/docker-deploy.test.ts` instead (it tests the real docker module): add `parkedContainerName` to that file's existing import from `../src/docker.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run (inside `server/`): `npx vitest run test/deploy.test.ts test/docker-deploy.test.ts`
Expected: FAIL — `parkedContainerName` not exported; details lack the parked suffix; rollback cleanup never calls `removeContainer` with the parked name.

- [ ] **Step 3: Implement**

In `server/src/docker.ts`, above `recreateContainer`:

```ts
/** Where recreateContainer parks the replaced container. deploy.ts uses
 * this to name leftovers in deployment details and to clean them up on
 * rollback — keep the two sides of the contract in one place. */
export function parkedContainerName(name: string, deploymentId: number): string {
  return `${name}-predeploy-${deploymentId}`;
}
```

and inside `recreateContainer` replace the inline template with:

```ts
  const parkedName = parkedContainerName(spec.name, deploymentId);
```

In `server/src/deploy.ts`: add `parkedContainerName` to the import from `./docker.js`, pass `rollbackOf` through, and rework `runPipeline`:

```ts
  active.set(spec.name, deploymentId);
  void runPipeline(deploymentId, spec, newImage, p.auditId, p.rollbackOf, p.log);
  return { ok: true, deploymentId, containerName: spec.name };
```

```ts
async function runPipeline(
  deploymentId: number,
  spec: RecreateSpec,
  newImage: string,
  auditId: number,
  rollbackOf: number | undefined,
  log: FastifyBaseLogger,
): Promise<void> {
  const parked = parkedContainerName(spec.name, deploymentId);
  // True once recreateContainer has resolved: from then on the old
  // container sits under the parked name (recreate failures rename it
  // back themselves before rethrowing).
  let oldIsParked = false;
  try {
    updateDeploymentStatus(deploymentId, "pulling");
    try {
      await pullImage(newImage);
    } catch (err) {
      // Rollback must work when the registry is down and locally-built
      // images may never have been pushed: a failed pull is fine as long
      // as the image is already on the host.
      if (!(await imageExistsLocally(newImage))) throw err;
      log.warn({ image: newImage }, "pull failed; deploying the local image");
    }

    updateDeploymentStatus(deploymentId, "recreating");
    const newContainerId = await recreateContainer(spec, newImage, deploymentId);
    oldIsParked = true;

    updateDeploymentStatus(deploymentId, "watching", { newContainerId });
    const health = await watchHealth(newContainerId);
    if (!health.healthy) {
      // The replacement stays up for debugging; rollback is one click
      // away. The old container stays parked — name it so the operator
      // can find it instead of discovering it in `docker ps -a` later.
      settle(
        deploymentId,
        auditId,
        "failed",
        `${health.reason ?? "health check failed"}; previous container parked as ${parked}`,
        log,
      );
      return;
    }

    let detail = `${spec.image} → ${newImage}`;
    try {
      await removeContainer(spec.id);
      oldIsParked = false;
    } catch (err) {
      log.warn({ err, container: spec.id }, "parked container cleanup failed");
      detail += `; parked container ${parked} not removed`;
    }
    if (rollbackOf !== undefined) {
      await removeParkedLeftover(spec.name, rollbackOf, log);
    }
    settle(deploymentId, auditId, "succeeded", detail, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : "deployment failed";
    settle(
      deploymentId,
      auditId,
      "failed",
      oldIsParked ? `${message}; previous container parked as ${parked}` : message,
      log,
    );
  } finally {
    active.delete(spec.name);
  }
}

/**
 * A successful rollback makes the parked container from the deployment it
 * rolls back redundant — the fleet is back on the old image. Best-effort:
 * 404 is the common case (rolling back a *succeeded* deployment, which
 * cleaned up after itself), so only unexpected failures are logged.
 */
async function removeParkedLeftover(
  name: string,
  rollbackOf: number,
  log: FastifyBaseLogger,
): Promise<void> {
  const leftover = parkedContainerName(name, rollbackOf);
  try {
    await removeContainer(leftover);
    log.info({ container: leftover }, "removed rolled-back deployment's parked container");
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) {
      log.warn({ err, container: leftover }, "parked leftover cleanup failed");
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (inside `server/`): `npx vitest run test/deploy.test.ts test/docker-deploy.test.ts test/deployments-routes.test.ts`
Expected: PASS (including the pre-existing pipeline tests with the updated health-failure detail).

- [ ] **Step 5: Commit**

```bash
git add server/src/docker.ts server/src/deploy.ts server/test/deploy.test.ts server/test/docker-deploy.test.ts
git commit -m "feat: name parked predeploy containers in deploy details, clean them on rollback"
```

---

### Task 4: Web UI surfaces the server's error message instead of "path → HTTP nnn"

Recorded follow-up (priority bumped by the deployment-workflow review): the shared `request()` wrapper throws `"${path} → HTTP ${status}"` and discards the `ApiError` body, so an operator sees `/api/containers/abc/deploy → HTTP 409` instead of "A deployment is already active for this container". Prefer `detail` (most specific), then `error`, then the old fallback. The 401 branch keeps its terse message — the app flips to the login screen anyway. `api.login` already parses its body; leave it.

**Files:**
- Modify: `web/src/api.ts`
- Test: `web/test/api.test.ts`, `web/test/AuditLog.test.tsx`, `web/test/FleetTable.test.tsx`, `web/test/RowActionsDeploy.test.tsx`

**Interfaces:**
- Consumes: `ApiError` from `web/src/types.ts` (generated mirror — already contains `error: string; detail?: string`).
- Produces: nothing used by later tasks.

- [ ] **Step 1: Write the failing tests**

In `web/test/api.test.ts`, replace the test `"throws with the status on other failures without firing the handler"` with:

```ts
  it("throws the server's error message without firing the handler", async () => {
    stubFetch({ "/api/overview": jsonResponse({ error: "boom" }, 502) });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await expect(api.overview()).rejects.toThrow("boom");
    expect(handler).not.toHaveBeenCalled();
  });

  it("prefers the more specific detail over the generic error", async () => {
    stubFetch({
      "/api/overview": jsonResponse(
        { error: "Action failed", detail: "invalid mount" },
        502,
      ),
    });

    await expect(api.overview()).rejects.toThrow("invalid mount");
  });

  it("falls back to path and status when the error body is not JSON", async () => {
    stubFetch({ "/api/overview": new Response("nope", { status: 502 }) });

    await expect(api.overview()).rejects.toThrow("/api/overview → HTTP 502");
  });
```

In the `containerAction` describe, update `"rejects with the HTTP status on failure"`:

```ts
  it("rejects with the server's error message on failure", async () => {
    stubFetch({
      "/api/containers/abc123/start": jsonResponse({ error: "Action failed" }, 502),
    });

    await expect(api.containerAction("abc123", "start")).rejects.toThrow("Action failed");
  });
```

Component tests asserting the old fallback text must now assert the surfaced message:
- `web/test/AuditLog.test.tsx` line ~97: `toHaveTextContent("HTTP 502")` → `toHaveTextContent("down")` (the stub body is `{ error: "down" }`).
- `web/test/FleetTable.test.tsx` line ~265: `findByText(/HTTP 502/)` → `findByText(/Action failed/)` (stub body `{ error: "Action failed" }`).
- `web/test/RowActionsDeploy.test.tsx` line ~102: `getByText(/HTTP 409/)` → `getByText(/conflict/)` (stub body `{ error: "conflict" }`).

- [ ] **Step 2: Run the tests to verify they fail**

Run (inside `web/`): `npx vitest run test/api.test.ts test/AuditLog.test.tsx test/FleetTable.test.tsx test/RowActionsDeploy.test.tsx`
Expected: FAIL — errors still carry the `path → HTTP nnn` text.

- [ ] **Step 3: Implement**

In `web/src/api.ts`: add `ApiError` to the type-only import from `./types`, and change `request()`:

```ts
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (res.status === 401) {
    onUnauthorized?.();
    throw new Error(`${path} → HTTP 401`);
  }
  if (!res.ok) {
    // Surface what the server actually said: ApiError bodies carry a
    // human-readable `error` and sometimes a more specific `detail`.
    const body = (await res.json().catch(() => null)) as Partial<ApiError> | null;
    throw new Error(body?.detail ?? body?.error ?? `${path} → HTTP ${res.status}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}
```

- [ ] **Step 4: Run the web suite to verify everything passes**

Run (inside `web/`): `npx vitest run`
Expected: PASS — the four touched files plus every other suite (LoginForm/DeployPanel stubs return proper `ApiError` bodies or reject before `request()` parses them).

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/test/api.test.ts web/test/AuditLog.test.tsx web/test/FleetTable.test.tsx web/test/RowActionsDeploy.test.tsx
git commit -m "feat: surface server error messages in web UI instead of raw HTTP status"
```

---

### Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Server package** — run inside `server/`:

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: typecheck clean, lint clean, all tests pass (165 pre-existing + new), build succeeds.

- [ ] **Step 2: Web package** — run inside `web/`:

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: typecheck clean, lint clean, all tests pass (60 pre-existing, some updated, plus new), build succeeds.

- [ ] **Step 3: Contract mirror unchanged** — run at the repo root:

```bash
node scripts/sync-types.mjs --check
```
Expected: clean — `server/src/types.ts` was not modified by this plan.

- [ ] **Step 4: No lockfile or dependency drift**

```bash
git status --porcelain
```
Expected: empty (everything committed, no stray `package-lock.json` changes).
