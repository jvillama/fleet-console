import type { FastifyBaseLogger } from "fastify";
import { updateEventOutcome } from "./audit.js";
import {
  createDeployment,
  findActiveDeployment,
  updateDeploymentStatus,
} from "./deployments.js";
import {
  imageExistsLocally,
  inspectForRecreate,
  parkedContainerName,
  pullImage,
  recreateContainer,
  removeContainer,
  watchHealth,
  type RecreateSpec,
} from "./docker.js";
import type { Role } from "./types.js";

/**
 * Deployment pipeline (Phase 3). requestDeploy validates and creates the
 * deployment row, then runs pull → recreate → watch detached from the HTTP
 * request. Progress lands in the deployments table; the audit row (inserted
 * fail-closed by the route before calling here) settles at the terminal
 * state. Single-flight per container NAME — the stable identity across
 * recreates.
 */

export type DeployRequestOutcome =
  | { ok: true; deploymentId: number; containerName: string }
  | { ok: false; code: 404 | 409 | 422 | 502; error: string };

export interface DeployRequestParams {
  /** Container id or name — anything the Docker API accepts. */
  container: string;
  /** New tag on the container's current repo. Ignored when image is set. */
  tag?: string;
  /** Full image ref to deploy — the rollback path. */
  image?: string;
  actor: string;
  role: Role;
  rollbackOf?: number;
  /** Audit row already inserted (provisional failure) by the route. */
  auditId: number;
  log: FastifyBaseLogger;
}

/**
 * Split repo:tag, tolerating registry ports and dropping digests. Null when
 * there is no repository to retag (bare image ids).
 */
export function parseImageRef(ref: string): { repo: string; tag: string } | null {
  if (ref.startsWith("sha256:") || /^[0-9a-f]{12,64}$/.test(ref)) return null;
  const base = ref.split("@")[0]!;
  const slash = base.lastIndexOf("/");
  const colon = base.lastIndexOf(":");
  if (colon > slash) return { repo: base.slice(0, colon), tag: base.slice(colon + 1) };
  return { repo: base, tag: "latest" };
}

const active = new Map<string, number>(); // container name → deployment id

export async function requestDeploy(p: DeployRequestParams): Promise<DeployRequestOutcome> {
  let spec: RecreateSpec;
  try {
    spec = await inspectForRecreate(p.container);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { ok: false, code: 404, error: "Container not found" };
    }
    return {
      ok: false,
      code: 502,
      error: err instanceof Error ? err.message : "Docker inspect failed",
    };
  }

  let newImage: string;
  if (p.image !== undefined) {
    newImage = p.image;
  } else {
    const parsed = parseImageRef(spec.image);
    if (parsed === null) {
      return { ok: false, code: 422, error: "Container image has no repository to retag" };
    }
    newImage = `${parsed.repo}:${p.tag}`;
  }
  if (newImage === spec.image) {
    return { ok: false, code: 422, error: "Container already runs that image" };
  }

  let deploymentId: number;
  try {
    if (active.has(spec.name) || findActiveDeployment(spec.name) !== null) {
      return {
        ok: false,
        code: 409,
        error: "A deployment is already active for this container",
      };
    }
    deploymentId = createDeployment({
      containerId: spec.id,
      containerName: spec.name,
      oldImage: spec.image,
      newImage,
      actor: p.actor,
      role: p.role,
      ...(p.rollbackOf !== undefined ? { rollbackOf: p.rollbackOf } : {}),
    });
  } catch (err) {
    // The engine never throws to the route — a store failure at validation
    // time becomes a structured outcome like every other failure.
    return {
      ok: false,
      code: 502,
      error: err instanceof Error ? err.message : "Deployment store unavailable",
    };
  }
  active.set(spec.name, deploymentId);
  void runPipeline(deploymentId, spec, newImage, p.auditId, p.rollbackOf, p.log);
  return { ok: true, deploymentId, containerName: spec.name };
}

async function runPipeline(
  deploymentId: number,
  spec: RecreateSpec,
  newImage: string,
  auditId: number,
  rollbackOf: number | undefined,
  log: FastifyBaseLogger,
): Promise<void> {
  const parked = parkedContainerName(spec.name, deploymentId);
  // True once recreateContainer has resolved: from then on the old
  // container sits under the parked name (recreate failures rename it
  // back themselves before rethrowing).
  let oldIsParked = false;
  try {
    updateDeploymentStatus(deploymentId, "pulling");
    try {
      await pullImage(newImage);
    } catch (err) {
      // Rollback must work when the registry is down and locally-built
      // images may never have been pushed: a failed pull is fine as long
      // as the image is already on the host.
      if (!(await imageExistsLocally(newImage))) throw err;
      log.warn({ image: newImage }, "pull failed; deploying the local image");
    }

    updateDeploymentStatus(deploymentId, "recreating");
    const newContainerId = await recreateContainer(spec, newImage, deploymentId);
    oldIsParked = true;

    updateDeploymentStatus(deploymentId, "watching", { newContainerId });
    const health = await watchHealth(newContainerId);
    if (!health.healthy) {
      // The replacement stays up for debugging; rollback is one click
      // away. The old container stays parked — name it so the operator
      // can find it instead of discovering it in `docker ps -a` later.
      settle(
        deploymentId,
        auditId,
        "failed",
        `${health.reason ?? "health check failed"}; previous container parked as ${parked}`,
        log,
      );
      return;
    }

    let detail = `${spec.image} → ${newImage}`;
    try {
      await removeContainer(spec.id);
      oldIsParked = false;
    } catch (err) {
      log.warn({ err, container: spec.id }, "parked container cleanup failed");
      detail += `; parked container ${parked} not removed`;
    }
    if (rollbackOf !== undefined) {
      await removeParkedLeftover(spec.name, rollbackOf, log);
    }
    settle(deploymentId, auditId, "succeeded", detail, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : "deployment failed";
    settle(
      deploymentId,
      auditId,
      "failed",
      oldIsParked ? `${message}; previous container parked as ${parked}` : message,
      log,
    );
  } finally {
    active.delete(spec.name);
  }
}

/**
 * A successful rollback makes the parked container from the deployment it
 * rolls back redundant — the fleet is back on the old image. Best-effort:
 * 404 is the common case (rolling back a *succeeded* deployment, which
 * cleaned up after itself), so only unexpected failures are logged.
 */
async function removeParkedLeftover(
  name: string,
  rollbackOf: number,
  log: FastifyBaseLogger,
): Promise<void> {
  const leftover = parkedContainerName(name, rollbackOf);
  try {
    await removeContainer(leftover);
    log.info({ container: leftover }, "removed rolled-back deployment's parked container");
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) {
      log.warn({ err, container: leftover }, "parked leftover cleanup failed");
    }
  }
}

function settle(
  deploymentId: number,
  auditId: number,
  status: "succeeded" | "failed",
  detail: string,
  log: FastifyBaseLogger,
): void {
  try {
    updateDeploymentStatus(deploymentId, status, { detail });
  } catch (err) {
    log.error({ err, deploymentId }, "deployment status update failed");
  }
  try {
    updateEventOutcome(auditId, status === "succeeded" ? "success" : "failure", detail);
  } catch (err) {
    // Same policy as actions.ts settleAudit: the work already happened,
    // nothing to undo — the row conservatively stays a provisional failure.
    log.error({ err, auditId }, "audit outcome update failed");
  }
}
