import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * SQLite connection + schema migrations. This is the only module that
 * touches better-sqlite3 — audit.ts (and, from Phase 3, deployments.ts)
 * own their tables' SQL through the shared handle.
 *
 * Migrations run once at init and are tracked with PRAGMA user_version:
 * index i in MIGRATIONS is applied when user_version === i, then the
 * version is bumped to i + 1. Append-only — never edit a shipped entry.
 */

const MIGRATIONS: string[] = [
  // 1 — audit_events. IF NOT EXISTS lets databases created before schema
  // versioning (table present, user_version 0) adopt the scheme without
  // data loss.
  `CREATE TABLE IF NOT EXISTS audit_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT    NOT NULL,
    actor   TEXT    NOT NULL,
    role    TEXT,
    action  TEXT    NOT NULL,
    target  TEXT,
    outcome TEXT    NOT NULL,
    ip      TEXT,
    detail  TEXT
  );`,
  // 2 — deployments (Phase 3). One row per deploy attempt; a rollback is
  // another row with rollback_of set. container_name is the stable key
  // across recreates (a deploy changes the container id).
  `CREATE TABLE deployments (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id      TEXT    NOT NULL,
    container_name    TEXT    NOT NULL,
    old_image         TEXT    NOT NULL,
    new_image         TEXT    NOT NULL,
    status            TEXT    NOT NULL,
    detail            TEXT,
    actor             TEXT    NOT NULL,
    role              TEXT    NOT NULL,
    rollback_of       INTEGER,
    new_container_id  TEXT,
    started_at        TEXT    NOT NULL,
    finished_at       TEXT
  );`,
];

let db: Database.Database | null = null;

export function initDb(path: string): void {
  closeDb();
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  migrate(db);
}

function migrate(d: Database.Database): void {
  const version = d.pragma("user_version", { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    d.exec(MIGRATIONS[v]!);
    d.pragma(`user_version = ${v + 1}`);
  }
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized — call initDb() first");
  return db;
}
