import type { ContainerState } from "../types";

/**
 * A small "server rack LED" — the one place the UI is allowed to glow.
 * Green steady = running, amber pulse = transitional, off/red = down.
 */
export function StatusLed({ state }: { state: ContainerState }) {
  const kind =
    state === "running"
      ? "led-ok"
      : state === "restarting" || state === "created" || state === "removing"
        ? "led-warn"
        : state === "paused"
          ? "led-paused"
          : "led-down";

  return <span className={`led ${kind}`} role="img" aria-label={state} />;
}
