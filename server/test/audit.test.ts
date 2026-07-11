import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeAudit,
  initAudit,
  queryEvents,
  recordEvent,
  updateEventOutcome,
} from "../src/audit.js";

beforeEach(() => {
  initAudit(":memory:");
});

afterEach(() => {
  closeAudit();
});

function record(actor: string, action = "auth.login", outcome: "success" | "failure" = "success") {
  recordEvent({ actor, role: "admin", action, outcome, ip: "127.0.0.1" });
}

describe("recordEvent / queryEvents", () => {
  it("round-trips an event with all fields", () => {
    recordEvent({
      actor: "alice",
      role: "admin",
      action: "auth.login",
      outcome: "success",
      target: "abc123",
      ip: "10.0.0.1",
      detail: '{"note":"hi"}',
    });

    const page = queryEvents({ limit: 10, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.events[0]).toMatchObject({
      actor: "alice",
      role: "admin",
      action: "auth.login",
      outcome: "success",
      target: "abc123",
      ip: "10.0.0.1",
      detail: '{"note":"hi"}',
    });
    expect(page.events[0]?.id).toBe(1);
    expect(page.events[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("stores null for omitted optional fields and null role", () => {
    recordEvent({ actor: "mallory", role: null, action: "auth.login_failed", outcome: "failure" });

    const page = queryEvents({ limit: 10, offset: 0 });
    expect(page.events[0]).toMatchObject({
      role: null,
      target: null,
      ip: null,
      detail: null,
    });
  });

  it("returns newest first and paginates", () => {
    for (let i = 1; i <= 5; i++) record(`user${i}`);

    const first = queryEvents({ limit: 2, offset: 0 });
    expect(first.total).toBe(5);
    expect(first.events.map((e) => e.actor)).toEqual(["user5", "user4"]);

    const next = queryEvents({ limit: 2, offset: 2 });
    expect(next.events.map((e) => e.actor)).toEqual(["user3", "user2"]);
  });

  it("filters by actor and action, with filtered totals", () => {
    record("alice", "auth.login");
    record("bob", "auth.login");
    record("alice", "auth.logout");

    const byActor = queryEvents({ limit: 10, offset: 0, actor: "alice" });
    expect(byActor.total).toBe(2);
    expect(byActor.events.every((e) => e.actor === "alice")).toBe(true);

    const byBoth = queryEvents({ limit: 10, offset: 0, actor: "alice", action: "auth.logout" });
    expect(byBoth.total).toBe(1);
    expect(byBoth.events[0]?.action).toBe("auth.logout");
  });

  it("throws when the store is closed (callers own the failure policy)", () => {
    closeAudit();
    expect(() => record("alice")).toThrow(/not initialized/);
    initAudit(":memory:"); // leave a store for afterEach
  });

  it("re-initializing gives a fresh store", () => {
    record("alice");
    initAudit(":memory:");
    expect(queryEvents({ limit: 10, offset: 0 }).total).toBe(0);
  });
});

describe("recordEvent return value / updateEventOutcome", () => {
  it("recordEvent returns the inserted row id", () => {
    const first = recordEvent({
      actor: "alice", role: "admin", action: "container.stop",
      outcome: "failure", detail: "incomplete", target: "abc123",
    });
    const second = recordEvent({
      actor: "alice", role: "admin", action: "container.stop",
      outcome: "failure", detail: "incomplete", target: "abc123",
    });

    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  it("rewrites outcome and clears detail when none is given", () => {
    const id = recordEvent({
      actor: "alice", role: "admin", action: "container.stop",
      outcome: "failure", detail: "incomplete", target: "abc123",
    });

    updateEventOutcome(id, "success");

    const [event] = queryEvents({ limit: 1, offset: 0 }).events;
    expect(event).toMatchObject({ outcome: "success", detail: null });
  });

  it("stores the new detail when given", () => {
    const id = recordEvent({
      actor: "alice", role: "admin", action: "container.start",
      outcome: "failure", detail: "incomplete", target: "abc123",
    });

    updateEventOutcome(id, "success", "no-op: already in desired state");

    const [event] = queryEvents({ limit: 1, offset: 0 }).events;
    expect(event).toMatchObject({
      outcome: "success",
      detail: "no-op: already in desired state",
    });
  });

  it("throws for a missing row id", () => {
    expect(() => updateEventOutcome(999, "success")).toThrow(/not found/);
  });
});
