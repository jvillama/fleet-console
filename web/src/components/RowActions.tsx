import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type {
  ContainerAction,
  ContainerState,
  ContainerSummary,
  Role,
} from "../types";

const CONFIRM_MS = 4000;

const LABELS: Record<ContainerAction, string> = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
};

/** Stop/restart interrupt a running workload — make the user click twice. */
const NEEDS_CONFIRM: readonly ContainerAction[] = ["stop", "restart"];

function availableActions(state: ContainerState): ContainerAction[] {
  if (state === "running" || state === "restarting") return ["stop", "restart"];
  if (state === "exited" || state === "created" || state === "dead") return ["start"];
  return []; // paused / removing: out of scope this slice
}

/**
 * Action buttons for one fleet row. Owns its own confirm/busy/error state;
 * reports the post-action container state up so the table can reflect it
 * before the next poll.
 */
export function RowActions({
  container,
  state,
  role,
  onStateChange,
  onDeployStarted,
}: {
  container: ContainerSummary;
  /** Effective state — the table may already be showing a post-action override. */
  state: ContainerState;
  role: Role;
  onStateChange: (id: string, state: ContainerState) => void;
  onDeployStarted: (container: ContainerSummary, deploymentId: number) => void;
}) {
  const [confirming, setConfirming] = useState<ContainerAction | null>(null);
  const [busy, setBusy] = useState<ContainerAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const [deploying, setDeploying] = useState(false);
  const [tag, setTag] = useState("");
  const [deployBusy, setDeployBusy] = useState(false);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function fire(action: ContainerAction): Promise<void> {
    setBusy(action);
    setError(null);
    try {
      const result = await api.containerAction(container.id, action);
      onStateChange(container.id, result.state);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function fireDeploy(): Promise<void> {
    setDeployBusy(true);
    setError(null);
    try {
      const res = await api.deployContainer(container.id, tag.trim());
      setDeploying(false);
      setTag("");
      onDeployStarted(container, res.deploymentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deploy failed");
    } finally {
      setDeployBusy(false);
    }
  }

  function handleClick(e: React.MouseEvent, action: ContainerAction): void {
    e.stopPropagation(); // the row click opens the log panel
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (NEEDS_CONFIRM.includes(action) && confirming !== action) {
      setConfirming(action);
      setError(null);
      timer.current = window.setTimeout(() => setConfirming(null), CONFIRM_MS);
      return;
    }
    setConfirming(null);
    void fire(action);
  }

  const actions = availableActions(state);
  if (actions.length === 0 && error === null && role !== "admin") return null;

  return (
    <span className="row-actions">
      {actions.map((action) => (
        <button
          key={action}
          className={confirming === action ? "action confirm" : "action"}
          disabled={busy !== null}
          onClick={(e) => handleClick(e, action)}
        >
          {busy === action
            ? "…"
            : confirming === action
              ? `Confirm ${action}?`
              : LABELS[action]}
        </button>
      ))}
      {role === "admin" && !deploying && (
        <button
          className="action"
          disabled={busy !== null || deployBusy}
          onClick={(e) => {
            e.stopPropagation();
            setDeploying(true);
            setError(null);
          }}
        >
          Deploy
        </button>
      )}
      {role === "admin" && deploying && (
        <span className="deploy-form" onClick={(e) => e.stopPropagation()}>
          <input
            className="deploy-tag"
            placeholder="new tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          />
          <button
            className="action confirm"
            disabled={deployBusy || tag.trim() === ""}
            onClick={() => void fireDeploy()}
          >
            {deployBusy ? "…" : "Deploy tag"}
          </button>
          <button
            className="action"
            disabled={deployBusy}
            onClick={() => {
              setDeploying(false);
              setTag("");
            }}
          >
            Cancel
          </button>
        </span>
      )}
      {error !== null && <span className="action-error">{error}</span>}
    </span>
  );
}
