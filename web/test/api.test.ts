import { describe, expect, it, vi } from "vitest";
import { api, formatBytes, logsSocketUrl, setUnauthorizedHandler } from "../src/api";
import { jsonResponse, stubFetch } from "./helpers";

describe("formatBytes", () => {
  it("formats byte counts with binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(104857600)).toBe("100.0 MiB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TiB");
  });

  it("caps at TiB instead of inventing units", () => {
    expect(formatBytes(1024 ** 5)).toBe("1024.0 TiB");
  });
});

describe("logsSocketUrl", () => {
  it("builds a same-origin ws URL over http", () => {
    expect(logsSocketUrl("abc123")).toBe(
      `ws://${window.location.host}/api/logs/abc123`,
    );
  });
});

describe("request wrapper", () => {
  it("fires the unauthorized handler and throws on 401", async () => {
    stubFetch({ "/api/overview": jsonResponse({ error: "Unauthorized" }, 401) });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await expect(api.overview()).rejects.toThrow("401");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("throws with the status on other failures without firing the handler", async () => {
    stubFetch({ "/api/overview": jsonResponse({ error: "boom" }, 502) });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await expect(api.overview()).rejects.toThrow("HTTP 502");
    expect(handler).not.toHaveBeenCalled();
  });

  it("resolves undefined for 204 responses", async () => {
    stubFetch({ "/api/logout": new Response(null, { status: 204 }) });

    await expect(api.logout()).resolves.toBeUndefined();
  });
});

describe("api.login", () => {
  it("sends credentials and returns the session user", async () => {
    const { calls } = stubFetch({
      "/api/login": jsonResponse({ username: "alice", role: "admin" }),
    });

    const user = await api.login("alice", "pw");

    expect(user).toEqual({ username: "alice", role: "admin" });
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ username: "alice", password: "pw" }));
  });

  it("surfaces the server's error message", async () => {
    stubFetch({ "/api/login": jsonResponse({ error: "Invalid credentials" }, 401) });

    await expect(api.login("alice", "wrong")).rejects.toThrow("Invalid credentials");
  });

  it("falls back to a generic message when the error body is not JSON", async () => {
    stubFetch({ "/api/login": new Response("nope", { status: 500 }) });

    await expect(api.login("a", "b")).rejects.toThrow("Login failed (HTTP 500)");
  });
});

describe("api.me", () => {
  it("returns null on 401 without firing the unauthorized handler", async () => {
    stubFetch({ "/api/me": jsonResponse({ error: "Unauthorized" }, 401) });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await expect(api.me()).resolves.toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns the session user when logged in", async () => {
    stubFetch({ "/api/me": jsonResponse({ username: "bob", role: "viewer" }) });

    await expect(api.me()).resolves.toEqual({ username: "bob", role: "viewer" });
  });
});

describe("api.audit", () => {
  it("builds the query string from provided params only", async () => {
    const { calls } = stubFetch({ "/api/audit": jsonResponse({ events: [], total: 0 }) });

    await api.audit({ limit: 10, offset: 20, actor: "alice", action: "" });

    expect(calls[0]?.url).toBe("/api/audit?limit=10&offset=20&actor=alice");
  });
});
