import { describe, expect, it } from "vitest";
import { createStreamRegistry } from "../src/routes/logs.js";

/** Mirrors MAX_STREAMS_PER_USER, which logs.ts keeps private. */
const CAP = 5;

/** Fills a key to the cap and hands back the release closures, in order. */
function fill(
  registry: ReturnType<typeof createStreamRegistry>,
  key: string,
): (() => void)[] {
  const releases: (() => void)[] = [];
  for (let i = 0; i < CAP; i += 1) {
    const release = registry.tryAcquire(key);
    if (release === null) throw new Error(`refused slot ${i + 1} of ${CAP}`);
    releases.push(release);
  }
  return releases;
}

describe("createStreamRegistry", () => {
  it("allows acquisitions up to the cap", () => {
    const registry = createStreamRegistry();

    expect(fill(registry, "alice")).toHaveLength(CAP);
  });

  it("refuses the acquisition past the cap", () => {
    const registry = createStreamRegistry();
    fill(registry, "alice");

    expect(registry.tryAcquire("alice")).toBeNull();
  });

  it("frees exactly one slot on release", () => {
    const registry = createStreamRegistry();
    const releases = fill(registry, "alice");
    expect(registry.tryAcquire("alice")).toBeNull();

    releases[0]?.();

    expect(registry.tryAcquire("alice")).not.toBeNull();
    expect(registry.tryAcquire("alice")).toBeNull();
  });

  it("ignores a repeated release instead of freeing a second slot", () => {
    const registry = createStreamRegistry();
    const releases = fill(registry, "alice");

    releases[0]?.();
    releases[0]?.();

    expect(registry.tryAcquire("alice")).not.toBeNull();
    expect(registry.tryAcquire("alice")).toBeNull();
  });

  it("keeps a separate budget per key", () => {
    const registry = createStreamRegistry();
    fill(registry, "alice");
    expect(registry.tryAcquire("alice")).toBeNull();

    expect(registry.tryAcquire("bob")).not.toBeNull();
  });

  it("forgets a key once its last stream is released", () => {
    const registry = createStreamRegistry();
    const release = registry.tryAcquire("alice");
    expect(registry.size).toBe(1);

    release?.();

    expect(registry.size).toBe(0);
  });
});
