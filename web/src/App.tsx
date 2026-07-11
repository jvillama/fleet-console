import { useEffect, useState } from "react";
import { api, setUnauthorizedHandler, usePolling } from "./api";
import { AuditLog } from "./components/AuditLog";
import { FleetTable } from "./components/FleetTable";
import { LogPanel } from "./components/LogPanel";
import { LoginForm } from "./components/LoginForm";
import type { ContainerSummary, SessionUser } from "./types";

const POLL_MS = 5000;

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setAuthChecked(true));
    return () => setUnauthorizedHandler(null);
  }, []);

  if (!authChecked) {
    return (
      <div className="shell">
        <div className="empty">
          <p>Checking session…</p>
        </div>
      </div>
    );
  }
  if (!user) {
    return <LoginForm onLogin={setUser} />;
  }
  return <Console user={user} onLogout={() => setUser(null)} />;
}

function Console({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [view, setView] = useState<"dashboard" | "audit">("dashboard");
  const [selected, setSelected] = useState<ContainerSummary | null>(null);
  const overview = usePolling(api.overview, POLL_MS);
  const containers = usePolling(api.containers, POLL_MS);

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      // The session may already be gone — logging out locally either way.
    }
    onLogout();
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1>Fleet Console</h1>
          <p className="host">
            {overview.data
              ? `host ${overview.data.hostName} · docker ${overview.data.dockerVersion}`
              : "connecting to host…"}
          </p>
        </div>
        <nav className="tabs">
          <button
            className={view === "dashboard" ? "tab active" : "tab"}
            onClick={() => setView("dashboard")}
          >
            Dashboard
          </button>
          <button
            className={view === "audit" ? "tab active" : "tab"}
            onClick={() => {
              setView("audit");
              setSelected(null);
            }}
          >
            Audit log
          </button>
        </nav>
        <dl className="counters">
          <div className="counter">
            <dt>Running</dt>
            <dd className="ok">{overview.data?.running ?? "–"}</dd>
          </div>
          <div className="counter">
            <dt>Stopped</dt>
            <dd className="down">{overview.data?.stopped ?? "–"}</dd>
          </div>
          <div className="counter">
            <dt>Total</dt>
            <dd>{overview.data?.total ?? "–"}</dd>
          </div>
        </dl>
        <div className="session">
          <span className="session-user">{user.username}</span>
          <button className="logout" onClick={() => void handleLogout()}>
            Log out
          </button>
        </div>
      </header>

      {view === "dashboard" ? (
        <>
          {containers.error && (
            <div className="banner" role="alert">
              Can’t reach the Fleet Console API ({containers.error}). Check that
              the server is running and has access to the Docker socket.
            </div>
          )}

          <main>
            {containers.loading ? (
              <div className="empty">
                <p>Loading fleet…</p>
              </div>
            ) : (
              <FleetTable
                containers={containers.data ?? []}
                role={user.role}
                onSelect={setSelected}
              />
            )}
          </main>
          {selected && (
            <LogPanel
              key={selected.id}
              container={selected}
              onClose={() => setSelected(null)}
            />
          )}
        </>
      ) : (
        <main>
          <AuditLog />
        </main>
      )}

      <footer className="statusline">
        <span>
          refresh {POLL_MS / 1000}s
          {containers.lastUpdated
            ? ` · last update ${containers.lastUpdated.toLocaleTimeString()}`
            : ""}
        </span>
        <span>fleet-console v0.2 · observe-only · authenticated</span>
      </footer>
    </div>
  );
}
