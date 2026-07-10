import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../src/App";
import { jsonResponse, stubFetch, type Route } from "./helpers";

const overview = {
  total: 1,
  running: 1,
  stopped: 0,
  dockerVersion: "29.0.0",
  hostName: "docker-host",
};

/** Routes for a logged-in console with an empty fleet. */
function consoleRoutes(): Record<string, Route> {
  return {
    "/api/me": jsonResponse({ username: "alice", role: "admin" }),
    "/api/overview": () => jsonResponse(overview),
    "/api/containers": () => jsonResponse([]),
  };
}

describe("App session flow", () => {
  it("shows the login screen when there is no session", async () => {
    stubFetch({ "/api/me": jsonResponse({ error: "Unauthorized" }, 401) });

    render(<App />);

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows the console for an existing session", async () => {
    stubFetch(consoleRoutes());

    render(<App />);

    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
    expect(await screen.findByText("No containers on this host yet.")).toBeInTheDocument();
  });

  it("logs in from the form and lands on the console", async () => {
    const user = userEvent.setup();
    stubFetch({
      "/api/me": jsonResponse({ error: "Unauthorized" }, 401),
      "/api/login": jsonResponse({ username: "alice", role: "admin" }),
      "/api/overview": () => jsonResponse(overview),
      "/api/containers": () => jsonResponse([]),
    });

    render(<App />);
    await user.type(await screen.findByLabelText("Username"), "alice");
    await user.type(screen.getByLabelText("Password"), "pw");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("logs out back to the login screen", async () => {
    const user = userEvent.setup();
    stubFetch({
      ...consoleRoutes(),
      "/api/logout": new Response(null, { status: 204 }),
    });

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Log out" }));

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("switches between the dashboard and the audit log", async () => {
    const user = userEvent.setup();
    stubFetch({
      ...consoleRoutes(),
      "/api/audit": () => jsonResponse({ events: [], total: 0 }),
    });

    render(<App />);
    await screen.findByText("No containers on this host yet.");

    await user.click(screen.getByRole("button", { name: "Audit log" }));
    expect(await screen.findByText("0 events")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dashboard" }));
    expect(await screen.findByText("No containers on this host yet.")).toBeInTheDocument();
  });

  it("returns to the login screen when the session dies mid-use", async () => {
    stubFetch({
      "/api/me": jsonResponse({ username: "alice", role: "admin" }),
      "/api/overview": () => jsonResponse({ error: "Unauthorized" }, 401),
      "/api/containers": () => jsonResponse({ error: "Unauthorized" }, 401),
    });

    render(<App />);

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});
