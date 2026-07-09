import { useEffect, useRef, useState } from "react";
import type {
  ContainerStats,
  ContainerSummary,
  FleetOverview,
} from "./types";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`${path} → HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  overview: () => getJson<FleetOverview>("/api/overview"),
  containers: () => getJson<ContainerSummary[]>("/api/containers"),
  stats: (id: string) => getJson<ContainerStats>(`/api/containers/${id}/stats`),
};

export interface Polled<T> {
  data: T | null;
  error: string | null;
  /** True only before the first successful load — refreshes are silent. */
  loading: boolean;
  lastUpdated: Date | null;
}

/**
 * Poll a fetcher on an interval. Refreshes update data in place without
 * flashing a loading state, so the dashboard reads as "live" rather than
 * "reloading". Pauses while the tab is hidden.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
): Polled<T> {
  const [state, setState] = useState<Polled<T>>({
    data: null,
    error: null,
    loading: true,
    lastUpdated: null,
  });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;

    async function tick(): Promise<void> {
      if (document.hidden) return;
      try {
        const data = await fetcherRef.current();
        if (!cancelled) {
          setState({
            data,
            error: null,
            loading: false,
            lastUpdated: new Date(),
          });
        }
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            error: err instanceof Error ? err.message : "Request failed",
            loading: false,
          }));
        }
      }
    }

    void tick();
    const id = window.setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [intervalMs]);

  return state;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
