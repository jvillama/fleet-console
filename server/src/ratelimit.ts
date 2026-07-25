import type { FastifyRequest } from "fastify";
import type { RateLimitOptions } from "@fastify/rate-limit";
import { recordEvent } from "./audit.js";
import type { ApiError } from "./types.js";

/**
 * Rate-limit policy for mutating routes. The plugin is registered with
 * `global: false` in app.ts, so limits are opt-in: routes spread the result
 * of rateLimitFor() into `config.rateLimit`. Limits, keying, the 429 body,
 * and the throttle audit live here and nowhere else — the same way authz.ts
 * owns role checks.
 *
 * Ordering matters: the instance-level session gate runs before any
 * route-level hook, so anonymous requests are rejected with 401 and never
 * spend a real user's budget. Requests that go on to fail validation (400)
 * or the role check (403) DO spend it — throttling a viewer hammering an
 * endpoint they cannot use is the point.
 */

const WINDOW = "1 minute";
const WINDOW_MS = 60_000;

/**
 * Audits a throttle once per key per window. The plugin's hooks don't offer
 * "first block in this window" — `onExceeded` fires on every blocked
 * request — so dedupe here, against a map owned by this route's limiter
 * (each route keeps its own counter, so the state belongs with it rather
 * than in module scope). Expiry is a full window from the first block
 * rather than the counter's remaining ttl, which onExceeded isn't given:
 * conservative, so at worst a row is skipped, never duplicated per request.
 * Bounded by the number of distinct keys that trip the limit.
 *
 * FAIL-OPEN, unlike the mutating routes' own audit: the fail-closed rule
 * exists so Docker is never touched without a record, and a throttled
 * request never reaches Docker. Turning an audit outage into a 503 here
 * would also disguise the throttle as a different error class.
 */
function auditThrottle(
  request: FastifyRequest,
  key: string,
  action: string,
  max: number,
  /** key → wall-clock expiry of its dedupe entry. */
  auditedWindows: Map<string, number>,
): void {
  const now = Date.now();
  for (const [entry, expiry] of auditedWindows) {
    if (expiry <= now) auditedWindows.delete(entry);
  }
  if (auditedWindows.has(key)) return;
  auditedWindows.set(key, now + WINDOW_MS);

  const user = request.session.get("user");
  // Container id for action/deploy routes, deployment id for rollback —
  // whatever identifies the thing the caller was hammering.
  const target = (request.params as { id?: string }).id;
  try {
    recordEvent({
      actor: user?.username ?? key,
      role: user?.role ?? null,
      action,
      ...(target !== undefined ? { target } : {}),
      outcome: "failure",
      detail: `rate limit exceeded (${max}/${WINDOW})`,
      ip: request.ip,
    });
  } catch (err) {
    request.log.error({ err, action, key }, "throttle audit write failed");
  }
}

/**
 * Route-level rate limit for a mutating endpoint. `action` is the audit
 * action name (`container.stop`, …) — the real action rather than a
 * synthetic `ratelimit.exceeded`, so a throttle shows up in that
 * container's history where an operator would look for it.
 */
export function rateLimitFor(action: string, max: number): RateLimitOptions {
  const auditedWindows = new Map<string, number>();
  return {
    max,
    timeWindow: WINDOW,
    // Per user, not per IP: operators behind one office NAT shouldn't
    // starve each other, and the bucket then matches the audit `actor`.
    // The ip fallback is unreachable behind the session gate, but keeps
    // this safe if it's ever applied to an open route.
    keyGenerator: (request) => request.session.get("user")?.username ?? request.ip,
    onExceeded: (request, key) =>
      auditThrottle(request, key, action, max, auditedWindows),
    errorResponseBuilder: (_request, context) => {
      const body: ApiError = {
        error: "Too Many Requests",
        detail: `Rate limit exceeded, retry in ${context.after}`,
      };
      // The plugin throws this; Fastify takes the status off the object but
      // serializes it as-is, so keep statusCode out of the JSON body — the
      // web reads `detail ?? error` and nothing else.
      return Object.defineProperty(body, "statusCode", {
        value: context.statusCode,
        enumerable: false,
      });
    },
  };
}
