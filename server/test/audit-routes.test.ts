import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { recordEvent } from "../src/audit.js";
import { loginAs } from "./helpers.js";
import type { AuditPage } from "../src/types.js";

let app: FastifyInstance;
let cookies: { session: string };

beforeEach(async () => {
  app = await buildApp();
  cookies = await loginAs(app); // also writes one auth.login event
});

afterEach(async () => {
  await app.close();
});

describe("GET /api/audit", () => {
  it("requires a session", async () => {
    const res = await app.inject({ url: "/api/audit" });

    expect(res.statusCode).toBe(401);
  });

  it("returns events newest first with a total", async () => {
    recordEvent({ actor: "bob", role: "viewer", action: "auth.logout", outcome: "success" });

    const res = await app.inject({ url: "/api/audit", cookies });

    expect(res.statusCode).toBe(200);
    const page = res.json<AuditPage>();
    expect(page.total).toBe(2); // loginAs + the manual event
    expect(page.events[0]?.action).toBe("auth.logout");
    expect(page.events[1]?.action).toBe("auth.login");
  });

  it("applies limit/offset and filters", async () => {
    for (let i = 0; i < 3; i++) {
      recordEvent({ actor: "bob", role: "viewer", action: "auth.logout", outcome: "success" });
    }

    const limited = await app.inject({ url: "/api/audit?limit=2", cookies });
    expect(limited.json<AuditPage>().events).toHaveLength(2);

    const offset = await app.inject({ url: "/api/audit?limit=2&offset=3", cookies });
    expect(offset.json<AuditPage>().events).toHaveLength(1);

    const filtered = await app.inject({ url: "/api/audit?actor=bob&action=auth.logout", cookies });
    const page = filtered.json<AuditPage>();
    expect(page.total).toBe(3);
    expect(page.events.every((e) => e.actor === "bob")).toBe(true);
  });

  it("clamps nonsense pagination values instead of failing", async () => {
    const res = await app.inject({ url: "/api/audit?limit=99999&offset=-4", cookies });

    expect(res.statusCode).toBe(200);
    expect(res.json<AuditPage>().total).toBe(1);
  });
});
