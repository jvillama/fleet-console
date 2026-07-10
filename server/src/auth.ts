import { readFileSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Role, SessionUser } from "./types.js";

/**
 * User store + password hashing. This is the only module that reads user
 * config (FLEET_USERS / FLEET_USERS_FILE) or verifies passwords — the same
 * "one module owns the dependency" pattern as docker.ts.
 */

export interface UserRecord {
  username: string;
  role: Role;
  passwordHash: string;
}

const ROLES: readonly string[] = ["admin", "operator", "viewer"];

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const saltHex = parts[1];
  const hashHex = parts[2];
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length === 0) return false;
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

// Verified for unknown usernames so a login attempt costs the same time
// whether or not the user exists (no username probing via timing).
const DUMMY_HASH = hashPassword("fleet-console-dummy");

export function loadUsers(env: NodeJS.ProcessEnv = process.env): UserRecord[] {
  const raw = env.FLEET_USERS_FILE
    ? readFileSync(env.FLEET_USERS_FILE, "utf8")
    : env.FLEET_USERS;
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("FLEET_USERS must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("FLEET_USERS must be a JSON array of users");
  }
  return parsed.map((entry, i) => {
    const u = entry as Partial<UserRecord>;
    if (
      typeof u.username !== "string" ||
      u.username.length === 0 ||
      typeof u.passwordHash !== "string" ||
      typeof u.role !== "string" ||
      !ROLES.includes(u.role)
    ) {
      throw new Error(
        `FLEET_USERS entry ${i} is invalid — need {username, role (admin|operator|viewer), passwordHash}`,
      );
    }
    return { username: u.username, role: u.role as Role, passwordHash: u.passwordHash };
  });
}

export function authenticate(
  username: string,
  password: string,
  users: UserRecord[],
): SessionUser | null {
  const user = users.find((u) => u.username === username);
  if (!user) {
    verifyPassword(password, DUMMY_HASH); // burn the same time as a real check
    return null;
  }
  return verifyPassword(password, user.passwordHash)
    ? { username: user.username, role: user.role }
    : null;
}
