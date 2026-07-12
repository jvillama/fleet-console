import { describe, expect, it } from "vitest";
import {
  authenticate,
  hashPassword,
  loadUsers,
  verifyPassword,
  type UserRecord,
} from "../src/auth.js";

describe("password hashing", () => {
  it("verifies a password against its own hash", () => {
    const hash = hashPassword("correct horse");
    expect(hash).toMatch(/^scrypt:[0-9a-f]+:[0-9a-f]+$/);
    expect(verifyPassword("correct horse", hash)).toBe(true);
  });

  it("rejects the wrong password", () => {
    const hash = hashPassword("correct horse");
    expect(verifyPassword("battery staple", hash)).toBe(false);
  });

  it("produces a different salt (and hash) every time", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects malformed stored hashes instead of throwing", () => {
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "plaintext")).toBe(false);
    expect(verifyPassword("x", "bcrypt:aa:bb")).toBe(false);
    expect(verifyPassword("x", "scrypt::")).toBe(false);
  });
});

describe("loadUsers", () => {
  it("parses users from FLEET_USERS JSON", () => {
    const users = loadUsers({
      FLEET_USERS: JSON.stringify([
        { username: "alice", role: "admin", passwordHash: "scrypt:aa:bb" },
      ]),
    });
    expect(users).toEqual([
      { username: "alice", role: "admin", passwordHash: "scrypt:aa:bb" },
    ]);
  });

  it("returns an empty list when nothing is configured", () => {
    expect(loadUsers({})).toEqual([]);
  });

  it("throws on invalid JSON", () => {
    expect(() =>
      loadUsers({ FLEET_USERS: "not json" }),
    ).toThrow(/valid JSON/);
  });

  it("throws on entries missing fields or with unknown roles", () => {
    expect(() =>
      loadUsers({
        FLEET_USERS: JSON.stringify([{ username: "a", role: "root", passwordHash: "x" }]),
      }),
    ).toThrow(/entry 0/);
    expect(() =>
      loadUsers({
        FLEET_USERS: JSON.stringify([{ username: "a" }]),
      }),
    ).toThrow(/entry 0/);
  });
});

describe("authenticate", () => {
  const users: UserRecord[] = [
    { username: "alice", role: "admin", passwordHash: hashPassword("correct horse") },
  ];

  it("returns the session user on valid credentials", () => {
    expect(authenticate("alice", "correct horse", users)).toEqual({
      username: "alice",
      role: "admin",
    });
  });

  it("returns null for a wrong password", () => {
    expect(authenticate("alice", "wrong", users)).toBeNull();
  });

  it("returns null for an unknown username", () => {
    expect(authenticate("mallory", "correct horse", users)).toBeNull();
  });
});
