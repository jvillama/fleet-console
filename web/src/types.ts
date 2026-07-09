/**
 * Mirror of server/src/types.ts — the API contract.
 * Keep the two files in sync (see note in the server copy).
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
  shortId: string;
  name: string;
  image: string;
  state: ContainerState;
  status: string;
  createdAt: string;
  ports: PortMapping[];
}

export interface PortMapping {
  containerPort: number;
  hostPort?: number;
  protocol: "tcp" | "udp";
}

export interface ContainerStats {
  id: string;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  sampledAt: string;
}

export interface FleetOverview {
  total: number;
  running: number;
  stopped: number;
  dockerVersion: string;
  hostName: string;
}
