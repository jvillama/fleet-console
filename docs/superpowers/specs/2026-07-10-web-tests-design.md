# Web Package Test Suite — Design

> Status: approved 2026-07-10
> Prereq: auth + audit (PR #1) and live log streaming (PR #2), both on main.
> Scope: tests only — no production `web/src` behavior changes.

## Goal

Give the web package the test suite the server already has: every component,
the polling hook, and the API wrapper covered by fast, daemon-free Vitest
tests, wired into CI so both packages gate merges the same way.

## Decisions (settled during brainstorming)

- **Scope: full coverage** — utilities, `usePolling`, all five components,
  and App-level session flow.
- **Stack: Vitest + jsdom + React Testing Library** (+ `user-event`,
  `jest-dom` matchers). Same runner as the server (Vitest 4.x); RTL for
  behavior-focused component tests. Not happy-dom, not Playwright.
- **Stub the browser boundary, not the module:** tests stub `fetch` and
  `WebSocket` globals via `vi.stubGlobal`; `api.ts` is never module-mocked.
  Components always run with the real request wrapper, real 401 handling,
  real query strings. No msw.
- Tests live in `web/test/` (mirrors `server/test/`); `npm run typecheck`
  includes them.

## Infrastructure

- **Dev-deps:** `vitest` (same major as server), `jsdom`,
  `@testing-library/react`, `@testing-library/user-event`,
  `@testing-library/jest-dom`.
- **`web/vitest.config.ts`:** `test.environment: "jsdom"`,
  `test.setupFiles: ["./test/setup.ts"]`. Explicit imports (no `globals`),
  matching the server's style.
- **`web/test/setup.ts`:** imports `@testing-library/jest-dom/vitest`;
  `afterEach`: RTL `cleanup()`, `vi.unstubAllGlobals()`,
  `setUnauthorizedHandler(null)`, `vi.useRealTimers()`.
- **`web/package.json`:** `"test": "vitest run"`, `"test:watch": "vitest"`.
- **`web/tsconfig.json`:** include the `test` directory.

## Test doubles — `web/test/helpers.ts`

- **`stubFetch(routes)`** — installs a `fetch` stub mapping
  `"METHOD path"` (or path prefix) to responses. Accepts either a plain
  value (wrapped in a JSON 200 `Response`), a `Response`, or a function
  returning a promise — the function form enables manually-deferred
  responses for race tests. Records calls for assertions on URLs/bodies.
- **`FakeWebSocket`** — class installed with
  `vi.stubGlobal("WebSocket", FakeWebSocket)`. Captures `url`; exposes the
  property handlers LogPanel assigns (`onopen`, `onmessage`, `onclose`);
  spies `send`/`close`; static `instances: FakeWebSocket[]` registry
  (cleared in setup's `afterEach`); test-side triggers `fireOpen()`,
  `fireMessage(data)`, `fireClose(code, reason)`.

## Coverage map

One test file per unit, in `web/test/`:

1. **`api.test.ts`** — `formatBytes` (0 B, exact unit boundaries, rounding,
   TiB cap); `logsSocketUrl` (ws for http, wss for https — location swapped
   via `Object.defineProperty`); request wrapper: 401 fires the
   unauthorized handler and throws, non-OK throws with status, 204 resolves
   undefined; `api.login` surfaces the server's `error` message and falls
   back to `Login failed (HTTP n)`; `api.me` returns null on 401 and does
   NOT fire the unauthorized handler; `api.audit` query-string building
   (limit/offset always when passed, actor/action only when truthy).
2. **`usePolling.test.ts`** — `renderHook` + fake timers: first load
   populates data and clears `loading`; interval refresh updates data
   without re-entering `loading`; a failing refresh keeps stale data and
   sets `error`; ticks skip while `document.hidden` is true (stubbed) and
   resume when visible; unmount clears the interval (no further fetches).
3. **`LoginForm.test.tsx`** — submit disabled until both fields filled;
   busy state during a pending login; success calls `onLogin` with the
   session user; failure renders the thrown message in the `role="alert"`
   element and re-enables the button.
4. **`FleetTable.test.tsx`** — empty state with hint; rows render name,
   shortId, image, status, formatted ports (host→container/proto and
   container-only forms); stats cells show real values for running
   containers and "—" when the stats fetch rejects (per-row degradation);
   row click calls `onSelect` with the container; StatusLed reflects state.
5. **`AuditLog.test.tsx`** — initial fetch renders events and total; typing
   in the actor filter refetches with `actor=` in the query; "Load more"
   fetches at `offset=events.length` and appends; **stale-response guard**:
   an older request resolving after a newer one is discarded (deferred
   responses resolved out of order — asserts the newer filter's data wins);
   failed fetch shows the error banner.
6. **`LogPanel.test.tsx`** — opens a `FakeWebSocket` at
   `logsSocketUrl(container.id)`; status transitions connecting → streaming
   on open; frames append as lines; buffer caps at 2,000 (oldest dropped);
   close code 1000 → "ended", non-1000 → "disconnected" with reason shown;
   Esc keydown calls `onClose`; unmount calls `socket.close()`. Scroll
   pinning: jsdom has no layout, so `scrollHeight`/`scrollTop`/
   `clientHeight` are defined manually on the scroller to assert pinned
   auto-scroll sets `scrollTop` and that scrolling up unpins (shows the
   jump-to-latest button).
7. **`App.test.tsx`** — `me()` → null renders LoginForm; `me()` → user
   renders Console (with overview/containers fetch stubs); completing the
   login form hands off to Console; logout returns to LoginForm; the
   Dashboard | Audit log toggle switches views; a 401 from a polled fetch
   (unauthorized handler) flips back to the login screen.

## CI

`.github/workflows/ci.yml`: the web job gains `npm test` between typecheck
and build, making both packages' gates symmetric.

## Out of scope

Snapshot tests; coverage thresholds; msw; browser/e2e tests (the compose
smoke test covers that layer); any change to `web/src` behavior. If a test
reveals a real product bug, stop and surface it rather than changing
`web/src` silently.
