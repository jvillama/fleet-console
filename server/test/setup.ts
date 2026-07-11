import { hashPassword } from "../src/auth.js";

// Deterministic auth environment for every test file. buildApp() reads these;
// individual tests that need different values must save and restore them.
process.env.FLEET_SESSION_SECRET = "vitest-session-secret-0123456789abcdef";
process.env.AUDIT_DB_PATH = ":memory:";
process.env.FLEET_USERS = JSON.stringify([
  { username: "alice", role: "admin", passwordHash: hashPassword("correct horse") },
  { username: "bob", role: "viewer", passwordHash: hashPassword("battery staple") },
  { username: "carol", role: "operator", passwordHash: hashPassword("staple correct") },
]);
delete process.env.FLEET_USERS_FILE;
delete process.env.FLEET_COOKIE_SECURE;
