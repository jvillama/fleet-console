import type { FastifyInstance } from "fastify";
import { queryEvents, type AuditQuery } from "../audit.js";

interface AuditQuerystring {
  limit?: string;
  offset?: string;
  actor?: string;
  action?: string;
}

/**
 * Read-only audit log. Session required via the global gate. Any
 * authenticated user may read it in this slice; restricting to admin comes
 * with role enforcement.
 */
export function auditRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: AuditQuerystring }>("/api/audit", (request) => {
    const rawLimit = Number(request.query.limit ?? 50);
    const rawOffset = Number(request.query.offset ?? 0);
    const query: AuditQuery = {
      limit: Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200)
        : 50,
      offset: Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0,
    };
    if (request.query.actor) query.actor = request.query.actor;
    if (request.query.action) query.action = request.query.action;
    return queryEvents(query);
  });
}
