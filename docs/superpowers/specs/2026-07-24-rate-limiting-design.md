# Rate Limiting on Mutating Routes — Design

**Date:** 2026-07-24
**Status:** Approved
**Roadmap line:** Deferred backlog Tier 3 — "rate limiting on mutating
routes" (most security-relevant remaining item)

## Problem

`@fastify/rate-limit` is registered in `server/src/app.ts` with
`global: false`, so limits are opt-in per route. Only `/api/login` opts in
(`routes/auth.ts`, 5 requests/minute). Every mutating route is unlimited:

- `POST /api/containers/:id/start|stop|restart` (`routes/actions.ts`)
- `POST /api/containers/:id/deploy` (`routes/deployments.ts`)
- `POST /api/deployments/:id/rollback` (`routes/deployments.ts`)

An authenticated operator — or anything holding a stolen session cookie —
can drive unbounded container churn. Deploys are the worst case: each one
pulls an image, recreates a container, and runs a health watch (~14s in the
2026-07-12 smoke test), so a loop is expensive on the daemon and the
registry, not just the API process.

## Constraints

- The plugin is already a dependency and already registered. No dependency
  change, therefore no lockfile regeneration (avoids the npm-10 gotcha).
- `trustProxy: 1` is set because nginx is the sole ingress and *appends* to
  `X-Forwarded-For`; only the rightmost entry is trustworthy. Anything
  keying on IP inherits that guarantee and must not weaken it.
- The session gate is an instance-level `onRequest` hook in `app.ts`;
  route-level hooks (including the limiter's) run after it. This ordering
  is load-bearing for the design below.
- Mutating routes audit **fail-closed** (insert provisional failure row,
  refuse with 503 if the insert fails, settle afterwards). Reads and auth
  audit fail-open. A new refusal path has to pick a side deliberately.
- The web `request()` helper surfaces `detail ?? error` from an `ApiError`
  body (shipped in Tier 2). A 429 body that does not fit that shape loses
  its useful text in the UI.

## Decision

A new module, `server/src/ratelimit.ts`, owns rate-limit policy and is the
only place limits, keying, and the 429 body are defined. It exports one
factory:

```ts
rateLimitFor(action: string, max: number): RateLimitOptions
```

`RateLimitOptions` is the plugin's own route-level config type (the type of
`config.rateLimit`); `keyGenerator`, `errorResponseBuilder`, and
`onExceeded` are all settable at route level through it.

Route files call it and spread the result into `config.rateLimit`. This
mirrors how `authz.ts` owns role checks and `audit.ts` owns its table.

Approaches considered and rejected: inlining `config.rateLimit` at all five
call sites (duplicates the key generator, error builder, and audit dedupe
five times), and a Fastify plugin wrapping the mutating routes (more
machinery than five route configs justify, and it fights the existing
`global: false` opt-in model).

### Limits

| Routes                        | Budget         |
| ----------------------------- | -------------- |
| `start`, `stop`, `restart`    | 20 / minute    |
| `deploy`, `rollback`          | 6 / minute     |
| `login` (unchanged)           | 5 / minute     |

20/minute is generous for a human clicking buttons and still stops scripted
hammering. Deploys get a much smaller budget because each is expensive; 6/
minute remains far above any realistic human deploy cadence, and the
existing per-container single-flight guard (409 while one is in flight)
already covers the concurrent case.

### Keying

`keyGenerator` returns the session username, falling back to `request.ip`:

```ts
(req) => req.session.get("user")?.username ?? req.ip
```

Per-user rather than per-IP so that operators behind one office NAT do not
starve each other, and so the bucket matches the `actor` column the audit
trail already records. The fallback is unreachable on these five routes —
the gate guarantees a session — but keeps the factory safe if it is ever
applied to an open route.

### Request flow

1. Instance `onRequest` gate → **401** when there is no valid session.
2. Route-level limiter → key = username → over budget: audit once (below),
   then **429**.
3. Otherwise the existing `preHandler` chain (`validateId`, `requireRole`)
   → handler → fail-closed audit insert → Docker.

Two consequences of that ordering, both intended:

- Unauthenticated requests are rejected at step 1 and never consume quota,
  so an attacker without a session cannot exhaust a real user's budget.
- Requests that go on to fail validation (400) or the role check (403) *do*
  consume quota, because the limiter runs before those preHandlers. A
  non-operator hammering `stop` should be throttled.

### 429 response

`errorResponseBuilder` returns the existing `ApiError` shape so the web
surfaces the retry hint instead of dropping the plugin's default `message`
field:

```json
{ "error": "Too Many Requests",
  "detail": "Rate limit exceeded, retry in 43 seconds" }
```

The plugin's default `Retry-After` header is kept. `types.ts` is unchanged —
`ApiError` already covers this — so there is no contract change and no
`sync-types` regeneration.

### Audit on throttle

One row per key per window:

```
actor: alice   role: operator   action: container.stop
target: <container id from route params>
outcome: failure
detail: "rate limit exceeded (20/1 minute)"
```

`action` stays the real action rather than a synthetic `ratelimit.exceeded`,
so the throttle appears in that container's action history where an operator
would look for it.

This write is **fail-open**: log and continue, still return 429. The
fail-closed rule exists to prevent Docker being touched without a record,
and a throttled request never reaches Docker, so there is nothing to
protect. Returning 503 here would also let an audit outage convert a
throttle into a different error class.

The plugin's hooks do not provide "first block in this window" on their own:
`onExceeding` fires on every *allowed* request and `onExceeded` fires on
every *blocked* one (`index.js`, inside the `isExceeded` branch). Dedupe is
therefore a module-local `Map<string, number>` mapping key → window expiry,
consulted before each audit write and pruned of expired entries on write.
Bounded by the number of distinct keys that trip a limit.

## Testing

New `server/test/ratelimit-routes.test.ts`, building a fresh app per test in
`beforeEach` like the other route files — this also resets the plugin's
in-memory store between tests. No existing test makes 20+ mutating calls
against one app instance, so the new limits cannot break them.

- 20 action calls pass, the 21st returns 429; 6 deploy calls pass, the 7th
  returns 429
- per-user keying: alice exhausted → bob's request still succeeds
- 429 body matches `ApiError` with a non-empty `detail`; `Retry-After`
  header present
- a burst of many blocked requests produces exactly one audit row, not one
  per request
- no session → 401, not 429, and quota is untouched
- an audit write that throws on the 429 path still returns 429 (fail-open,
  no 500)

## Implementation notes

Three details settled while building it:

- The dedupe map is created **inside** `rateLimitFor`, one per limiter,
  rather than in module scope. Each route already keeps its own counter, so
  the state belongs with it — and module-scope state would have leaked
  between tests that build fresh apps.
- The plugin `throw`s whatever `errorResponseBuilder` returns and never sets
  the reply code itself; Fastify reads `statusCode` off the thrown value but
  serializes a plain object as-is. The field is therefore attached
  non-enumerable, so the 429 body stays exactly `{error, detail}`.
- `deploy` and `rollback` get 6/minute **each** (separate routes, separate
  counters), not 6/minute shared.

## Out of scope

- Read routes stay unlimited.
- The WebSocket logs route is untouched; its backpressure gap is a separate
  Tier 3 item.
- `login` keeps its existing 5/minute limit and per-IP keying.
- The store stays the plugin's default in-memory one, which is correct for
  the single-instance compose deployment. Horizontal scaling would need the
  Redis store; not a concern for this topology.
