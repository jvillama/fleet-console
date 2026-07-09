import { api, usePolling } from "./api";
import { FleetTable } from "./components/FleetTable";

const POLL_MS = 5000;

export default function App() {
  const overview = usePolling(api.overview, POLL_MS);
  const containers = usePolling(api.containers, POLL_MS);

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
      </header>

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
          <FleetTable containers={containers.data ?? []} />
        )}
      </main>

      <footer className="statusline">
        <span>
          refresh {POLL_MS / 1000}s
          {containers.lastUpdated
            ? ` · last update ${containers.lastUpdated.toLocaleTimeString()}`
            : ""}
        </span>
        <span>fleet-console v0.1 · phase 1: read-only</span>
      </footer>
    </div>
  );
}
