import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { closeAudit, queryEvents } from "../src/audit.js";
import { loginAs } from "./helpers.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe("POST /api/login", () => {
  it("logs in a configured user and sets the session cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "alice", password: "correct horse" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ username: "alice", role: "admin" });
    const cookie = res.cookies.find((c) => c.name === "session");
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe("strict");
  });

  it("rejects a wrong password with a generic 401 and no cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "alice", password: "wrong" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Invalid credentials" });
    expect(res.cookies.find((c) => c.name === "session")).toBeUndefined();
  });

  it("rejects an unknown user with the same generic 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "mallory", password: "whatever" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Invalid credentials" });
  });

  it("rejects a malformed body with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "alice" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/me", () => {
  it("returns the session user with a valid cookie", async () => {
    const cookies = await loginAs(app);

    const res = await app.inject({ url: "/api/me", cookies });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ username: "alice", role: "admin" });
  });

  it("returns 401 without a session", async () => {
    const res = await app.inject({ url: "/api/me" });

    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/logout", () => {
  it("clears the session cookie", async () => {
    const cookies = await loginAs(app);

    const res = await app.inject({ method: "POST", url: "/api/logout", cookies });

    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((c) => c.name === "session");
    expect(cleared).toBeDefined();
    expect(cleared?.value).toBe("");
  });
});

describe("audit trail of auth events", () => {
  it("records failed then successful logins, newest first", async () => {
    await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "alice", password: "wrong" },
    });
    await loginAs(app);

    const page = queryEvents({ limit: 10, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.events[0]).toMatchObject({
      actor: "alice",
      role: "admin",
      action: "auth.login",
      outcome: "success",
    });
    expect(page.events[1]).toMatchObject({
      actor: "alice",
      role: null,
      action: "auth.login_failed",
      outcome: "failure",
    });
    expect(page.events[0]?.ip).toBeTruthy();
  });

  it("records logout", async () => {
    const cookies = await loginAs(app);
    await app.inject({ method: "POST", url: "/api/logout", cookies });

    const page = queryEvents({ limit: 10, offset: 0, action: "auth.logout" });
    expect(page.total).toBe(1);
    expect(page.events[0]).toMatchObject({ actor: "alice", outcome: "success" });
  });

  it("fails open: login still succeeds when the audit write fails", async () => {
    closeAudit();

    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "alice", password: "correct horse" },
    });

    expect(res.statusCode).toBe(200);
  });
});

describe("login rate limiting", () => {
  it("returns 429 after 5 attempts in a minute", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "alice", password: "wrong" },
      });
      expect(res.statusCode).toBe(401);
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "alice", password: "correct horse" },
    });

    expect(blocked.statusCode).toBe(429);
  });
});
