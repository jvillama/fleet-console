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

// --- Auth + audit (mirrored in server/src/types.ts) -----------------------

export type Role = "admin" | "operator" | "viewer";

export interface SessionUser {
  username: string;
  role: Role;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuditEvent {
  id: number;
  ts: string; // ISO 8601 UTC
  actor: string;
  /** Null when the actor was unauthenticated (failed login attempt). */
  role: Role | null;
  /** Dotted verb, e.g. "auth.login", later "container.start". */
  action: string;
  /** Null for auth events; container id for Phase 2 container actions. */
  target: string | null;
  outcome: "success" | "failure";
  ip: string | null;
  detail: string | null;
}

export interface AuditPage {
  events: AuditEvent[];
  total: number;
}

// --- Container actions (Phase 2, mirrored in web/src/types.ts) ---------

export type ContainerAction = "start" | "stop" | "restart";

export interface ContainerActionResult {
  id: string;
  action: ContainerAction;
  /** Container state after the action, from a post-action inspect. */
  state: ContainerState;
}
