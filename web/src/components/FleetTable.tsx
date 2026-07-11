import { useEffect, useState } from "react";
import { api, formatBytes } from "../api";
import type { ContainerState, ContainerStats, ContainerSummary, Role } from "../types";
import { RowActions } from "./RowActions";
import { StatusLed } from "./StatusLed";

function formatPorts(c: ContainerSummary): string {
  if (c.ports.length === 0) return "—";
  return c.ports
    .map((p) =>
      p.hostPort !== undefined
        ? `${p.hostPort}→${p.containerPort}/${p.protocol}`
        : `${p.containerPort}/${p.protocol}`,
    )
    .join(", ");
}

/**
 * Fetch stats for all running containers whenever the container list
 * changes. Requests run in parallel; failures degrade to "—" per row
 * rather than breaking the table.
 */
function useFleetStats(
  containers: ContainerSummary[],
): Record<string, ContainerStats> {
  const [stats, setStats] = useState<Record<string, ContainerStats>>({});
  const runningIds = containers
    .filter((c) => c.state === "running")
    .map((c) => c.id)
    .join(",");

  useEffect(() => {
    if (runningIds === "") {
      setStats({});
      return;
    }
    let cancelled = false;

    void (async () => {
      const ids = runningIds.split(",");
      const results = await Promise.allSettled(ids.map((id) => api.stats(id)));
      if (cancelled) return;
      const next: Record<string, ContainerStats> = {};
      for (const r of results) {
        if (r.status === "fulfilled") next[r.value.id] = r.value;
      }
      setStats(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [runningIds]);

  return stats;
}

export function FleetTable({
  containers,
  role,
  onSelect,
}: {
  containers: ContainerSummary[];
  role: Role;
  onSelect: (container: ContainerSummary) => void;
}) {
  const stats = useFleetStats(containers);
  // Post-action states shown until the next poll delivers fresh truth.
  const [stateOverrides, setStateOverrides] = useState<Record<string, ContainerState>>({});

  useEffect(() => setStateOverrides({}), [containers]);

  const canAct = role !== "viewer";

  if (containers.length === 0) {
    return (
      <div className="empty">
        <p>No containers on this host yet.</p>
        <p className="empty-hint">
          Start one to see it appear here — try{" "}
          <code>docker run -d --name hello nginx:alpine</code>
        </p>
      </div>
    );
  }

  return (
    <table className="fleet">
      <thead>
        <tr>
          <th aria-label="status" />
          <th>Name</th>
          <th>Image</th>
          <th>Status</th>
          <th>Ports</th>
          <th className="num">CPU</th>
          <th className="num">Memory</th>
          {canAct && <th aria-label="actions" />}
        </tr>
      </thead>
      <tbody>
        {containers.map((c) => {
          const s = stats[c.id];
          const state = stateOverrides[c.id] ?? c.state;
          return (
            <tr
              key={c.id}
              className={state !== "running" ? "row-down" : ""}
              onClick={() => onSelect(c)}
            >
              <td>
                <StatusLed state={state} />
              </td>
              <td>
                <span className="name">{c.name}</span>
                <span className="short-id">{c.shortId}</span>
              </td>
              <td className="image">{c.image}</td>
              <td>{c.status}</td>
              <td className="ports">{formatPorts(c)}</td>
              <td className="num">
                {s ? `${s.cpuPercent.toFixed(1)}%` : "—"}
              </td>
              <td className="num">
                {s
                  ? `${formatBytes(s.memoryUsageBytes)} / ${formatBytes(s.memoryLimitBytes)}`
                  : "—"}
              </td>
              {canAct && (
                <td className="actions-cell">
                  <RowActions
                    container={c}
                    state={state}
                    onStateChange={(id, next) =>
                      setStateOverrides((prev) => ({ ...prev, [id]: next }))
                    }
                  />
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
