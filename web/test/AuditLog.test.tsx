import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/components/AuditLog";
import type { AuditEvent, AuditPage } from "../src/types";
import { deferred, jsonResponse, stubFetch } from "./helpers";

function evt(id: number, actor: string, action = "auth.login"): AuditEvent {
  return {
    id,
    ts: "2026-07-10T12:00:00.000Z",
    actor,
    role: "admin",
    action,
    target: null,
    outcome: "success",
    ip: "10.0.0.1",
    detail: null,
  };
}

function page(events: AuditEvent[], total = events.length): AuditPage {
  return { events, total };
}

describe("AuditLog", () => {
  it("renders the first page and the total", async () => {
    stubFetch({ "/api/audit": () => jsonResponse(page([evt(1, "alice")])) });

    render(<AuditLog />);

    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(screen.getByText("1 event")).toBeInTheDocument();
  });

  it("refetches with the actor filter as the user types", async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ "/api/audit": () => jsonResponse(page([])) });

    render(<AuditLog />);
    await screen.findByText("0 events");
    await user.type(screen.getByPlaceholderText("Filter by user"), "bob");

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("actor=bob"))).toBe(true),
    );
  });

  it("loads more at the current offset and appends", async () => {
    const user = userEvent.setup();
    const firstPage = Array.from({ length: 50 }, (_, i) => evt(i + 1, `user${i + 1}`));
    const { calls } = stubFetch({
      "/api/audit": (url) =>
        url.includes("offset=50")
          ? jsonResponse(page([evt(51, "user51")], 51))
          : jsonResponse(page(firstPage, 51)),
    });

    render(<AuditLog />);
    await screen.findByText("user1");
    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("user51")).toBeInTheDocument();
    expect(screen.getByText("user1")).toBeInTheDocument(); // appended, not replaced
    expect(calls.some((c) => c.url.includes("offset=50"))).toBe(true);
  });

  it("discards a stale response that resolves after a newer one", async () => {
    const user = userEvent.setup();
    const stale = deferred<Response>();
    let call = 0;
    stubFetch({
      "/api/audit": () => {
        call++;
        // Call 1 is the unfiltered initial load — left pending (stale).
        if (call === 1) return stale.promise;
        return jsonResponse(page([evt(2, "bob")]));
      },
    });

    render(<AuditLog />);
    await user.type(screen.getByPlaceholderText("Filter by user"), "b");
    expect(await screen.findByText("bob")).toBeInTheDocument();

    stale.resolve(jsonResponse(page([evt(1, "alice")])));
    await act(async () => {});

    expect(screen.queryByText("alice")).not.toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("shows the error banner when the fetch fails", async () => {
    stubFetch({ "/api/audit": () => jsonResponse({ error: "down" }, 502) });

    render(<AuditLog />);

    expect(await screen.findByRole("alert")).toHaveTextContent("down");
  });
});
