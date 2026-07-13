import { getDb } from "./db.js";
import type { AuditEvent, AuditOutcome, AuditPage, Role } from "./types.js";

/**
 * Audit log storage. Table access lives here; the SQLite connection and
 * schema migrations live in db.ts (the only module touching better-sqlite3).
 *
 * recordEvent() throws on failure; callers choose the policy. Observe-only
 * callers fail open (log and continue). Mutating endpoints fail closed
 * (refuse the action if the write fails).
 */

export interface NewAuditEvent {
  actor: string;
  role: Role | null;
  action: string;
  outcome: AuditOutcome;
  target?: string;
  ip?: string;
  detail?: string;
}

export interface AuditQuery {
  limit: number;
  offset: number;
  actor?: string;
  action?: string;
}

export function recordEvent(event: NewAuditEvent): number {
  const result = getDb()
    .prepare(
      `INSERT INTO audit_events (ts, actor, role, action, target, outcome, ip, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      event.actor,
      event.role,
      event.action,
      event.target ?? null,
      event.outcome,
      event.ip ?? null,
      event.detail ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function queryEvents(q: AuditQuery): AuditPage {
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (q.actor) {
    where.push("actor = @actor");
    params.actor = q.actor;
  }
  if (q.action) {
    where.push("action = @action");
    params.action = q.action;
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const d = getDb();
  const total = (
    d.prepare(`SELECT COUNT(*) AS n FROM audit_events ${whereSql}`).get(params) as { n: number }
  ).n;
  const events = d
    .prepare(
      `SELECT id, ts, actor, role, action, target, outcome, ip, detail
       FROM audit_events ${whereSql}
       ORDER BY id DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: q.limit, offset: q.offset }) as AuditEvent[];
  return { events, total };
}

/**
 * Rewrites a previously inserted event's outcome (and detail). Used by the
 * fail-closed insert-then-update pattern: mutating routes insert the row as
 * a provisional failure before acting, then settle it here afterwards.
 */
export function updateEventOutcome(
  id: number,
  outcome: AuditOutcome,
  detail?: string,
): void {
  const result = getDb()
    .prepare(`UPDATE audit_events SET outcome = ?, detail = ? WHERE id = ?`)
    .run(outcome, detail ?? null, id);
  if (result.changes === 0) {
    throw new Error(`audit event ${id} not found`);
  }
}
