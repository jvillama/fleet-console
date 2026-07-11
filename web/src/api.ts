import { useEffect, useRef, useState } from "react";
import type {
  AuditPage,
  ContainerAction,
  ContainerActionResult,
  ContainerStats,
  ContainerSummary,
  FleetOverview,
  SessionUser,
} from "./types";

let onUnauthorized: (() => void) | null = null;

/** Called whenever an API request returns 401 — the app flips to the login screen. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (res.status === 401) {
    onUnauthorized?.();
    throw new Error(`${path} → HTTP 401`);
  }
  if (!res.ok) {
    throw new Error(`${path} → HTTP ${res.status}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

function getJson<T>(path: string): Promise<T> {
  return request<T>(path);
}

export const api = {
  overview: () => getJson<FleetOverview>("/api/overview"),
  containers: () => getJson<ContainerSummary[]>("/api/containers"),
  stats: (id: string) => getJson<ContainerStats>(`/api/containers/${id}/stats`),
  containerAction: (id: string, action: ContainerAction) =>
    request<ContainerActionResult>(`/api/containers/${id}/${action}`, {
      method: "POST",
    }),

  /** Throws with the server's error message (e.g. "Invalid credentials"). */
  login: async (username: string, password: string): Promise<SessionUser> => {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Login failed (HTTP ${res.status})`);
    }
    return res.json() as Promise<SessionUser>;
  },

  logout: () => request<void>("/api/logout", { method: "POST" }),

  /** Session probe: null means "not logged in" (never an error, never the 401 handler). */
  me: async (): Promise<SessionUser | null> => {
    const res = await fetch("/api/me");
    if (res.status === 401) return null;
    if (!res.ok) throw new Error(`/api/me → HTTP ${res.status}`);
    return res.json() as Promise<SessionUser>;
  },

  audit: (params: { limit?: number; offset?: number; actor?: string; action?: string }) => {
    const qs = new URLSearchParams();
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    if (params.actor) qs.set("actor", params.actor);
    if (params.action) qs.set("action", params.action);
    return getJson<AuditPage>(`/api/audit?${qs.toString()}`);
  },
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

/** Same-origin WebSocket URL for a container's live log stream. */
export function logsSocketUrl(id: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/api/logs/${id}`;
}
