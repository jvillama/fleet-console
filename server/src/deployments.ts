import { getDb } from "./db.js";
import type { Deployment, DeploymentPage, DeploymentStatus, Role } from "./types.js";

/**
 * Deployment history storage (Phase 3). One row per deploy attempt; the
 * deploy engine advances status through the pipeline and rollbacks are new
 * rows with rollback_of set. Keyed by container NAME for history queries —
 * a recreate changes the container id, the name survives.
 */

export interface NewDeployment {
  containerId: string;
  containerName: string;
  oldImage: string;
  newImage: string;
  actor: string;
  role: Role;
  rollbackOf?: number;
}

const TERMINAL: readonly DeploymentStatus[] = ["succeeded", "failed"];
const ACTIVE_SQL = "('pending', 'pulling', 'recreating', 'watching')";

interface Row {
  id: number;
  container_id: string;
  container_name: string;
  old_image: string;
  new_image: string;
  status: DeploymentStatus;
  detail: string | null;
  actor: string;
  role: Role;
  rollback_of: number | null;
  new_container_id: string | null;
  started_at: string;
  finished_at: string | null;
}

function toDeployment(r: Row): Deployment {
  return {
    id: r.id,
    containerId: r.container_id,
    containerName: r.container_name,
    oldImage: r.old_image,
    newImage: r.new_image,
    status: r.status,
    detail: r.detail,
    actor: r.actor,
    role: r.role,
    rollbackOf: r.rollback_of,
    newContainerId: r.new_container_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

const COLUMNS = `id, container_id, container_name, old_image, new_image, status,
  detail, actor, role, rollback_of, new_container_id, started_at, finished_at`;

export function createDeployment(d: NewDeployment): number {
  const result = getDb()
    .prepare(
      `INSERT INTO deployments
         (container_id, container_name, old_image, new_image, status,
          actor, role, rollback_of, started_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .run(
      d.containerId,
      d.containerName,
      d.oldImage,
      d.newImage,
      d.actor,
      d.role,
      d.rollbackOf ?? null,
      new Date().toISOString(),
    );
  return Number(result.lastInsertRowid);
}

export function updateDeploymentStatus(
  id: number,
  status: DeploymentStatus,
  patch: { detail?: string; newContainerId?: string } = {},
): void {
  const finishedAt = TERMINAL.includes(status) ? new Date().toISOString() : null;
  const result = getDb()
    .prepare(
      `UPDATE deployments
       SET status = ?,
           detail = COALESCE(?, detail),
           new_container_id = COALESCE(?, new_container_id),
           finished_at = COALESCE(?, finished_at)
       WHERE id = ?`,
    )
    .run(status, patch.detail ?? null, patch.newContainerId ?? null, finishedAt, id);
  if (result.changes === 0) {
    throw new Error(`deployment ${id} not found`);
  }
}

export function getDeployment(id: number): Deployment | null {
  const row = getDb()
    .prepare(`SELECT ${COLUMNS} FROM deployments WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? toDeployment(row) : null;
}

export function queryDeployments(q: {
  container?: string;
  limit: number;
  offset: number;
}): DeploymentPage {
  const whereSql = q.container !== undefined ? "WHERE container_name = @container" : "";
  const params: Record<string, string | number> = {};
  if (q.container !== undefined) params.container = q.container;

  const d = getDb();
  const total = (
    d.prepare(`SELECT COUNT(*) AS n FROM deployments ${whereSql}`).get(params) as { n: number }
  ).n;
  const rows = d
    .prepare(
      `SELECT ${COLUMNS} FROM deployments ${whereSql}
       ORDER BY id DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: q.limit, offset: q.offset }) as Row[];
  return { deployments: rows.map(toDeployment), total };
}

export function findActiveDeployment(containerName: string): Deployment | null {
  const row = getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM deployments
       WHERE container_name = ? AND status IN ${ACTIVE_SQL}
       ORDER BY id DESC LIMIT 1`,
    )
    .get(containerName) as Row | undefined;
  return row ? toDeployment(row) : null;
}

/**
 * Startup sweep: a server restart orphans in-flight pipelines, so any
 * non-terminal row is settled as failed. Returns the number swept.
 */
export function failInterrupted(): number {
  const result = getDb()
    .prepare(
      `UPDATE deployments
       SET status = 'failed', detail = 'interrupted by server restart', finished_at = ?
       WHERE status IN ${ACTIVE_SQL}`,
    )
    .run(new Date().toISOString());
  return result.changes;
}
