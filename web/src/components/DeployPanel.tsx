import { useRef, useState } from "react";
import { api, usePolling } from "../api";
import type { ContainerSummary, Deployment, Role } from "../types";

const POLL_MS = 2000;
const PHASES = ["pulling", "recreating", "watching"] as const;
const PHASE_ORDER: Record<Deployment["status"], number> = {
  pending: 0,
  pulling: 1,
  recreating: 2,
  watching: 3,
  succeeded: 4,
  failed: 4,
};

function isTerminal(d: Deployment): boolean {
  return d.status === "succeeded" || d.status === "failed";
}

/**
 * Live view of one deployment: phase progression while the pipeline runs,
 * outcome + one-click rollback when it settles. State lives server-side, so
 * a refresh resumes from the deployments table. Once the deployment is
 * terminal the fetcher short-circuits to the cached row — the interval
 * keeps ticking but no more requests go out.
 *
 * `usePolling`'s effect only depends on `intervalMs` (by design — it holds
 * the fetcher in a ref so unrelated re-renders don't reset the interval).
 * That means a rollback's `setCurrentId` alone can't make it refetch under
 * the new id before the next tick. `DeployBody` is keyed on `currentId` so
 * a rollback remounts it — a fresh `usePolling` instance for the new id —
 * the same trick `App.tsx` uses to reset `LogPanel`/`DeployPanel` on
 * selection change.
 */
export function DeployPanel({
  container,
  deploymentId,
  role,
  onClose,
}: {
  container: ContainerSummary;
  deploymentId: number;
  role: Role;
  onClose: () => void;
}) {
  const [currentId, setCurrentId] = useState(deploymentId);

  return (
    <aside className="deploy-panel" aria-label={`Deployment for ${container.name}`}>
      <header className="panel-head">
        <h2>
          Deploy — <span className="name">{container.name}</span>
        </h2>
        <button className="action" onClick={onClose}>
          Close
        </button>
      </header>

      <DeployBody
        key={currentId}
        currentId={currentId}
        role={role}
        onRolledBack={setCurrentId}
      />
    </aside>
  );
}

function DeployBody({
  currentId,
  role,
  onRolledBack,
}: {
  currentId: number;
  role: Role;
  onRolledBack: (deploymentId: number) => void;
}) {
  const [confirmingRollback, setConfirmingRollback] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const doneRef = useRef<Deployment | null>(null);

  const polled = usePolling(async () => {
    if (doneRef.current !== null) return doneRef.current;
    const d = await api.getDeployment(currentId);
    if (isTerminal(d)) doneRef.current = d;
    return d;
  }, POLL_MS);
  const dep = polled.data;

  async function fireRollback(): Promise<void> {
    setRollbackBusy(true);
    setRollbackError(null);
    try {
      const res = await api.rollbackDeployment(currentId);
      setConfirmingRollback(false);
      onRolledBack(res.deploymentId);
    } catch (err) {
      setRollbackError(err instanceof Error ? err.message : "Rollback failed");
      setRollbackBusy(false);
    }
  }

  return (
    <>
      {polled.error !== null && dep === null && (
        <p className="action-error" role="alert">
          {polled.error}
        </p>
      )}

      {dep !== null && (
        <>
          <p className="deploy-images">
            {dep.oldImage} → {dep.newImage}
          </p>
          <p className="deploy-meta">
            #{dep.id} · by {dep.actor}
            {dep.rollbackOf !== null ? ` · rollback of #${dep.rollbackOf}` : ""}
          </p>

          {isTerminal(dep) ? (
            <p
              className={dep.status === "succeeded" ? "deploy-ok" : "deploy-fail"}
              role="status"
            >
              {dep.status === "succeeded"
                ? "Deployment succeeded"
                : `Deployment failed — ${dep.detail ?? "no detail"}`}
            </p>
          ) : (
            <ol className="deploy-phases">
              {PHASES.map((phase, i) => {
                const idx = i + 1;
                const cls =
                  PHASE_ORDER[dep.status] > idx
                    ? "done"
                    : PHASE_ORDER[dep.status] === idx
                      ? "current"
                      : "pending";
                return (
                  <li key={phase} className={cls}>
                    {phase}
                  </li>
                );
              })}
            </ol>
          )}

          {isTerminal(dep) && role === "admin" && (
            <span className="deploy-rollback">
              <button
                className={confirmingRollback ? "action confirm" : "action"}
                disabled={rollbackBusy}
                onClick={() =>
                  confirmingRollback ? void fireRollback() : setConfirmingRollback(true)
                }
              >
                {rollbackBusy
                  ? "…"
                  : confirmingRollback
                    ? "Confirm roll back?"
                    : "Roll back"}
              </button>
              {rollbackError !== null && (
                <span className="action-error">{rollbackError}</span>
              )}
            </span>
          )}
        </>
      )}
    </>
  );
}
