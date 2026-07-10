// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://console.example.com:8443/"}
import { describe, expect, it } from "vitest";
import { logsSocketUrl } from "../src/api";

describe("logsSocketUrl over https", () => {
  it("uses wss and preserves the host and port", () => {
    expect(logsSocketUrl("abc")).toBe("wss://console.example.com:8443/api/logs/abc");
  });
});
