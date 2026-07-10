import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LoginForm } from "../src/components/LoginForm";
import { deferred, jsonResponse, stubFetch } from "./helpers";

async function fillForm(username = "alice", password = "pw") {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Username"), username);
  await user.type(screen.getByLabelText("Password"), password);
  return user;
}

describe("LoginForm", () => {
  it("disables submit until both fields are filled", async () => {
    const user = userEvent.setup();
    render(<LoginForm onLogin={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Sign in" });

    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText("Username"), "alice");
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText("Password"), "pw");
    expect(button).toBeEnabled();
  });

  it("shows a busy state while login is pending, then hands off the user", async () => {
    const pending = deferred<Response>();
    stubFetch({ "/api/login": () => pending.promise });
    const onLogin = vi.fn();
    render(<LoginForm onLogin={onLogin} />);

    const user = await fillForm();
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();

    pending.resolve(jsonResponse({ username: "alice", role: "admin" }));
    await waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith({ username: "alice", role: "admin" }),
    );
  });

  it("shows the server's error and re-enables the form", async () => {
    stubFetch({ "/api/login": jsonResponse({ error: "Invalid credentials" }, 401) });
    render(<LoginForm onLogin={vi.fn()} />);

    const user = await fillForm("alice", "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credentials");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });
});
