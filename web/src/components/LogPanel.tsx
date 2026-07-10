import { useEffect, useRef, useState } from "react";
import { logsSocketUrl } from "../api";
import type { ContainerSummary } from "../types";

const MAX_LINES = 2000;

type StreamStatus = "connecting" | "streaming" | "ended" | "disconnected";

export function LogPanel({
  container,
  onClose,
}: {
  container: ContainerSummary;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [reason, setReason] = useState<string | null>(null);
  const [pinned, setPinned] = useState(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLines([]);
    setStatus("connecting");
    setReason(null);
    setPinned(true);

    const socket = new WebSocket(logsSocketUrl(container.id));
    socket.onopen = () => setStatus("streaming");
    socket.onmessage = (event) => {
      setLines((prev) => {
        const next = [...prev, String(event.data)];
        return next.length > MAX_LINES
          ? next.slice(next.length - MAX_LINES)
          : next;
      });
    };
    socket.onclose = (event) => {
      setStatus(event.code === 1000 ? "ended" : "disconnected");
      if (event.reason) setReason(event.reason);
    };
    return () => socket.close();
  }, [container.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (pinned && scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [lines, pinned]);

  function handleScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 4);
  }

  return (
    <aside className="log-panel">
      <header className="log-header">
        <div>
          <span className="name">{container.name}</span>
          <span className="short-id">{container.shortId}</span>
        </div>
        <span className={`log-status log-status-${status}`}>
          {status}
          {reason ? ` — ${reason}` : ""}
        </span>
        <button className="log-close" onClick={onClose} aria-label="Close logs">
          ×
        </button>
      </header>
      <div className="log-lines" ref={scrollerRef} onScroll={handleScroll}>
        {lines.length === 0 && status !== "connecting" ? (
          <p className="log-empty">No log output.</p>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="log-line">
              {line}
            </div>
          ))
        )}
      </div>
      {!pinned && (
        <button className="log-jump" onClick={() => setPinned(true)}>
          ↓ Jump to latest
        </button>
      )}
    </aside>
  );
}
