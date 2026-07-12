import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { closeDb, getDb, initDb } from "../src/db.js";

let tmpDir: string | null = null;

afterEach(() => {
  closeDb();
  if (tmpDir !== null) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("initDb / migrations", () => {
  it("creates the audit table and stamps user_version on a fresh database", () => {
    initDb(":memory:");
    const version = getDb().pragma("user_version", { simple: true });
    expect(version).toBeGreaterThanOrEqual(1);
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("audit_events");
  });

  it("adopts a pre-versioning database without losing audit rows", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "fleet-db-"));
    const path = join(tmpDir, "audit.db");
    // Simulate a database created before migrations existed: audit_events
    // present, user_version still 0.
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE audit_events (
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
    legacy
      .prepare(
        "INSERT INTO audit_events (ts, actor, action, outcome) VALUES (?, ?, ?, ?)",
      )
      .run("2026-07-01T00:00:00.000Z", "alice", "auth.login", "success");
    legacy.close();

    initDb(path);

    const rows = getDb().prepare("SELECT actor FROM audit_events").all() as {
      actor: string;
    }[];
    expect(rows).toEqual([{ actor: "alice" }]);
    expect(getDb().pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(1);
  });

  it("getDb throws before init and after close", () => {
    expect(() => getDb()).toThrow(/not initialized/);
    initDb(":memory:");
    closeDb();
    expect(() => getDb()).toThrow(/not initialized/);
  });
});
