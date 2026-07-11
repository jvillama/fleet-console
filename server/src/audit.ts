import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { AuditEvent, AuditPage, Role } from "./types.js";

/**
 * Audit log storage. This is the only module that touches better-sqlite3 —
 * the same "one module owns the dependency" pattern as docker.ts.
 *
 * recordEvent() throws on failure; callers choose the policy. In this
 * observe-only slice callers fail open (log and continue). Phase 2 mutating
 * endpoints must fail closed (refuse the action if the write fails).
 */

export interface NewAuditEvent {
  actor: string;
  role: Role | null;
  action: string;
  outcome: "success" | "failure";
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

let db: Database.Database | null = null;

export function initAudit(path: string): void {
  closeAudit();
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      TEXT    NOT NULL,
      actor   TEXT    NOT NULL,
      role    TEXT,
      action  TEXT    NOT NULL,
      target  TEXT,
      outcome TEXT    NOT NULL,
      ip      TEXT,
      detail  TEXT
    );
  `);
}

export function closeAudit(): void {
  db?.close();
  db = null;
}

function requireDb(): Database.Database {
  if (!db) throw new Error("Audit store not initialized — call initAudit() first");
  return db;
}

export function recordEvent(event: NewAuditEvent): number {
  const result = requireDb()
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

  const d = requireDb();
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
  outcome: "success" | "failure",
  detail?: string,
): void {
  const result = requireDb()
    .prepare(`UPDATE audit_events SET outcome = ?, detail = ? WHERE id = ?`)
    .run(outcome, detail ?? null, id);
  if (result.changes === 0) {
    throw new Error(`audit event ${id} not found`);
  }
}
