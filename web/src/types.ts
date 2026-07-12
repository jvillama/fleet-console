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

// --- Container actions (Phase 2, mirrored in server/src/types.ts) ------

export type ContainerAction = "start" | "stop" | "restart";

export interface ContainerActionResult {
  id: string;
  action: ContainerAction;
  /** Container state after the action, from a post-action inspect. */
  state: ContainerState;
}

// --- Deployments (Phase 3, mirrored in server/src/types.ts) ---------------

export type DeploymentStatus =
  | "pending"      // row created, pipeline not yet started
  | "pulling"      // pulling the new image
  | "recreating"   // stop old / rename / create + start new
  | "watching"     // health watch on the new container
  | "succeeded"
  | "failed";

export interface Deployment {
  id: number;
  /** Container the deploy targeted (id before the recreate). */
  containerId: string;
  /** Stable identity across recreates — history and rollback key on this. */
  containerName: string;
  /** Full ref before the deploy, e.g. "nginx:1.27-alpine". */
  oldImage: string;
  /** Full ref deployed, e.g. "nginx:1.28-alpine". */
  newImage: string;
  status: DeploymentStatus;
  /** Failure reason or success summary. */
  detail: string | null;
  actor: string;
  role: Role;
  /** Deployment id this one rolls back, else null. */
  rollbackOf: number | null;
  /** Set once the replacement container exists. */
  newContainerId: string | null;
  startedAt: string; // ISO 8601
  finishedAt: string | null;
}

export interface DeployRequest {
  tag: string;
}

export interface DeployAccepted {
  deploymentId: number;
}

export interface DeploymentPage {
  deployments: Deployment[];
  total: number;
}
