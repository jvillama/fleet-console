import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AuditEvent } from "../types";

const PAGE_SIZE = 50;

export function AuditLog() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestSeq = useRef(0);

  async function load(offset: number, replace: boolean) {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.audit({
        limit: PAGE_SIZE,
        offset,
        ...(actor ? { actor } : {}),
        ...(action ? { action } : {}),
      });
      if (seq !== requestSeq.current) return;
      setTotal(page.total);
      setEvents((prev) => (replace ? page.events : [...prev, ...page.events]));
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : "Failed to load audit log");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load(0, true);
    // Refetch from the top whenever a filter changes.
  }, [actor, action]);

  return (
    <section className="audit">
      <div className="audit-filters">
        <input
          placeholder="Filter by user"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
        />
        <input
          placeholder="Filter by action"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        />
        <span className="audit-count">
          {total} event{total === 1 ? "" : "s"}
        </span>
      </div>

      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      {events.length === 0 && !loading ? (
        <div className="empty">
          <p>No audit events match.</p>
        </div>
      ) : (
        <table className="fleet audit-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>User</th>
              <th>Action</th>
              <th>Target</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="short-id">{new Date(e.ts).toLocaleString()}</td>
                <td className="name">{e.actor}</td>
                <td className="image">{e.action}</td>
                <td className="short-id">{e.target ?? "—"}</td>
                <td className={e.outcome === "success" ? "outcome-ok" : "outcome-fail"}>
                  {e.outcome}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {events.length < total && (
        <button
          className="audit-more"
          disabled={loading}
          onClick={() => void load(events.length, false)}
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
