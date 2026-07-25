import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { recordEvent, updateEventOutcome, updateEventTarget } from "../audit.js";
import { requireRole } from "../authz.js";
import { requestDeploy } from "../deploy.js";
import { getDeployment, queryDeployments } from "../deployments.js";
import { rateLimitFor } from "../ratelimit.js";
import type {
  ApiError,
  AuditOutcome,
  DeployAccepted,
  DeployRequest,
} from "../types.js";

/**
 * Phase 3 deployment routes. The two POSTs audit FAIL-CLOSED like
 * actions.ts: the event row is inserted (provisional failure) before any
 * Docker access, and the request is refused with 503 if that insert fails.
 * Because the pipeline is async, the row settles when the deployment
 * reaches a terminal state — not when the 202 goes out.
 */

const ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
// Docker tag grammar: word char start, then word chars, dots, dashes.
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

// Much tighter than container actions: every deploy pulls an image,
// recreates a container and runs a health watch. Still far above any
// realistic human deploy cadence, and the per-container single-flight
// guard (409) already covers concurrency.
const DEPLOYS_PER_MINUTE = 6;

function settleAudit(
  request: FastifyRequest,
  auditId: number,
  outcome: AuditOutcome,
  detail?: string,
): void {
  try {
    updateEventOutcome(auditId, outcome, detail);
  } catch (err) {
    request.log.error({ err, auditId }, "audit outcome update failed");
  }
}

function insertAuditOr503(
  request: FastifyRequest,
  reply: FastifyReply,
  action: string,
  target: string,
): number | null {
  const user = request.session.get("user")!;
  try {
    return recordEvent({
      actor: user.username,
      role: user.role,
      action,
      target,
      outcome: "failure",
      detail: "incomplete",
      ip: request.ip,
    });
  } catch (err) {
    request.log.error({ err }, "audit write failed — refusing deployment");
    const body: ApiError = { error: "Audit log unavailable" };
    void reply.code(503).send(body);
    return null;
  }
}

export function deploymentsRoutes(app: FastifyInstance): void {
  app.post<{ Params: { id: string }; Body: DeployRequest }>(
    "/api/containers/:id/deploy",
    {
      config: {
        rateLimit: rateLimitFor("container.deploy", DEPLOYS_PER_MINUTE),
      },
      preHandler: [
        async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
          if (!ID_PATTERN.test(request.params.id)) {
            const body: ApiError = { error: "Invalid container id" };
            return reply.code(400).send(body);
          }
        },
        requireRole("admin", { action: "container.deploy" }),
      ],
    },
    async (request, reply) => {
      const { id } = request.params;
      const tag = (request.body as Partial<DeployRequest> | null)?.tag;
      if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
        const body: ApiError = { error: "Invalid image tag" };
        return reply.code(400).send(body);
      }

      const user = request.session.get("user")!;
      const auditId = insertAuditOr503(request, reply, "container.deploy", id);
      if (auditId === null) return;

      const result = await requestDeploy({
        container: id,
        tag,
        actor: user.username,
        role: user.role,
        auditId,
        log: request.log,
      });
      if (!result.ok) {
        settleAudit(request, auditId, "failure", result.error);
        const body: ApiError = { error: result.error };
        return reply.code(result.code).send(body);
      }
      // The row was inserted (fail-closed) before the container was
      // resolved, so its target is whatever the client sent — id or name.
      // Pin it to the stable name, the identity rollback rows and
      // deployment history key on. Fail open: the pipeline is already
      // running and the row itself is intact.
      try {
        updateEventTarget(auditId, result.containerName);
      } catch (err) {
        request.log.error({ err, auditId }, "audit target update failed");
      }
      const body: DeployAccepted = { deploymentId: result.deploymentId };
      return reply.code(202).send(body);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/deployments/:id/rollback",
    {
      config: {
        rateLimit: rateLimitFor("container.rollback", DEPLOYS_PER_MINUTE),
      },
      preHandler: [requireRole("admin", { action: "container.rollback" })],
    },
    async (request, reply) => {
      const depId = Number(request.params.id);
      if (!Number.isInteger(depId) || depId < 1) {
        const body: ApiError = { error: "Invalid deployment id" };
        return reply.code(400).send(body);
      }
      const source = getDeployment(depId);
      if (source === null) {
        const body: ApiError = { error: "Deployment not found" };
        return reply.code(404).send(body);
      }

      const user = request.session.get("user")!;
      const auditId = insertAuditOr503(
        request,
        reply,
        "container.rollback",
        source.containerName,
      );
      if (auditId === null) return;

      const result = await requestDeploy({
        container: source.containerName,
        image: source.oldImage,
        actor: user.username,
        role: user.role,
        rollbackOf: source.id,
        auditId,
        log: request.log,
      });
      if (!result.ok) {
        settleAudit(request, auditId, "failure", result.error);
        const body: ApiError = { error: result.error };
        return reply.code(result.code).send(body);
      }
      const body: DeployAccepted = { deploymentId: result.deploymentId };
      return reply.code(202).send(body);
    },
  );

  app.get<{ Params: { id: string } }>("/api/deployments/:id", async (request, reply) => {
    const depId = Number(request.params.id);
    const dep = Number.isInteger(depId) && depId >= 1 ? getDeployment(depId) : null;
    if (dep === null) {
      const body: ApiError = { error: "Deployment not found" };
      return reply.code(404).send(body);
    }
    return dep;
  });

  app.get<{ Querystring: { container?: string; limit?: string; offset?: string } }>(
    "/api/deployments",
    (request) => {
      const rawLimit = Number(request.query.limit ?? 50);
      const rawOffset = Number(request.query.offset ?? 0);
      const query: { container?: string; limit: number; offset: number } = {
        limit: Number.isFinite(rawLimit)
          ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200)
          : 50,
        offset: Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0,
      };
      if (request.query.container) query.container = request.query.container;
      return queryDeployments(query);
    },
  );
}
