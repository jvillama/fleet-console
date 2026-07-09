/**
 * API contract types.
 *
 * NOTE: web/src/types.ts mirrors this file. If you change a type here,
 * change it there too. (Phase 2 improvement: extract to a shared package
 * or generate from an OpenAPI schema — good interview talking point.)
 */

export type ContainerState =
  | "running"
  | "exited"
  | "paused"
  | "restarting"
  | "created"
  | "dead"
  | "removing";

export interface ContainerSummary {
  id: string;
  /** Short 12-char id, convenient for display */
  shortId: string;
  name: string;
  image: string;
  state: ContainerState;
  /** Human-readable status from Docker, e.g. "Up 3 hours" */
  status: string;
  createdAt: string; // ISO 8601
  ports: PortMapping[];
}

export interface PortMapping {
  containerPort: number;
  hostPort?: number;
  protocol: "tcp" | "udp";
}

export interface ContainerStats {
  id: string;
  /** CPU usage as a percentage of one core (can exceed 100 on multi-core) */
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  sampledAt: string; // ISO 8601
}

export interface FleetOverview {
  total: number;
  running: number;
  stopped: number;
  dockerVersion: string;
  hostName: string;
}

export interface ApiError {
  error: string;
  detail?: string;
}
