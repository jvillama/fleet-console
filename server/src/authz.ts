import type { FastifyReply, FastifyRequest } from "fastify";
import { auditFailOpen } from "./routes/auth.js";
import type { ApiError, Role } from "./types.js";

/**
 * Role gate for routes that need more than a valid session. The global
 * onRequest gate in app.ts has already rejected anonymous/expired sessions,
 * so a missing user here is a bug — treated as forbidden, not a crash.
 */

const ROLE_ORDER: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export function requireRole(min: Role, audit: { action: string }) {
  return async function roleGate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const user = request.session.get("user");
    if (user && ROLE_ORDER[user.role] >= ROLE_ORDER[min]) return;

    // A viewer probing mutation endpoints is exactly what an audit log is
    // for. Fail-open: the action was refused anyway, nothing to close.
    const targetId = (request.params as { id?: string }).id;
    auditFailOpen(request, {
      actor: user?.username ?? "unknown",
      role: user?.role ?? null,
      action: audit.action,
      ...(targetId !== undefined ? { target: targetId } : {}),
      outcome: "failure",
      detail: "forbidden",
      ip: request.ip,
    });
    const body: ApiError = { error: "Forbidden" };
    return reply.code(403).send(body);
  };
}
