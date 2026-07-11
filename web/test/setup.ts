import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { setUnauthorizedHandler } from "../src/api";
import { FakeWebSocket } from "./helpers";

// RTL's asyncWrapper drains microtasks with a setTimeout(0) that it only
// advances past when `jestFakeTimersAreEnabled()` — a check that needs a
// global `jest` object. Without this shim, every `await user.click()` hangs
// forever while vi.useFakeTimers() is active. The shim is inert under real
// timers: RTL also requires sinon's `clock` marker on setTimeout before
// calling it.
(globalThis as { jest?: unknown }).jest = {
  advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms),
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setUnauthorizedHandler(null);
  FakeWebSocket.instances = [];
});
