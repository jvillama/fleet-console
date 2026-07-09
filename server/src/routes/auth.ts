import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticate, loadUsers } from "../auth.js";
import { recordEvent, type NewAuditEvent } from "../audit.js";
import type { ApiError, LoginRequest } from "../types.js";

/**
 * Fail-open audit policy for this observe-only slice: a failed audit write is
 * logged but never blocks the request. Phase 2 mutating endpoints must
 * fail closed instead (refuse the action when the audit write fails).
 */
function audit(request: FastifyRequest, event: NewAuditEvent): void {
  try {
    recordEvent(event);
  } catch (err) {
    request.log.error({ err }, "audit write failed");
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/login", async (request, reply) => {
    const { username, password } = (request.body ?? {}) as Partial<LoginRequest>;
    if (typeof username !== "string" || typeof password !== "string") {
      const body: ApiError = { error: "username and password are required" };
      return reply.code(400).send(body);
    }

    const user = authenticate(username, password, loadUsers());
    if (!user) {
      audit(request, {
        actor: username,
        role: null,
        action: "auth.login_failed",
        outcome: "failure",
        ip: request.ip,
      });
      const body: ApiError = { error: "Invalid credentials" };
      return reply.code(401).send(body);
    }

    request.session.set("user", user);
    request.session.set("issuedAt", Date.now());
    audit(request, {
      actor: user.username,
      role: user.role,
      action: "auth.login",
      outcome: "success",
      ip: request.ip,
    });
    return user;
  });

  app.post("/api/logout", async (request, reply) => {
    const user = request.session.get("user");
    request.session.delete();
    if (user) {
      audit(request, {
        actor: user.username,
        role: user.role,
        action: "auth.logout",
        outcome: "success",
        ip: request.ip,
      });
    }
    return reply.code(204).send();
  });

  // Session probe. Checks the session itself (not just the gate) so it works
  // and is testable independent of the gate hook.
  app.get("/api/me", async (request, reply) => {
    const user = request.session.get("user");
    if (!user) {
      const body: ApiError = { error: "Unauthorized" };
      return reply.code(401).send(body);
    }
    return user;
  });
}
