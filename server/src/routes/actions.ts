import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  restartContainer,
  startContainer,
  stopContainer,
  type ActionOutcome,
} from "../docker.js";
import { recordEvent, updateEventOutcome } from "../audit.js";
import { requireRole } from "../authz.js";
import type {
  ApiError,
  ContainerAction,
  ContainerActionResult,
} from "../types.js";

/**
 * Phase 2 mutating routes. Unlike the observe-only routes these audit
 * FAIL-CLOSED: the event row is inserted (as a provisional failure) before
 * dockerode is touched, and the action is refused with 503 if that insert
 * fails. The row is settled to the real outcome afterwards.
 */

// Container ids are hex; names are alphanumeric with ._- (same as stats).
const ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

type ActionRequest = FastifyRequest<{ Params: { id: string } }>;

async function validateId(
  request: ActionRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!ID_PATTERN.test(request.params.id)) {
    const body: ApiError = { error: "Invalid container id" };
    return reply.code(400).send(body);
  }
}

function settleAudit(
  request: ActionRequest,
  auditId: number,
  outcome: "success" | "failure",
  detail?: string,
): void {
  try {
    updateEventOutcome(auditId, outcome, detail);
  } catch (err) {
    // The action already ran — nothing to undo. The row conservatively
    // stays a provisional failure; log the discrepancy loudly.
    request.log.error({ err, auditId }, "audit outcome update failed");
  }
}

function registerAction(
  app: FastifyInstance,
  action: ContainerAction,
  run: (id: string) => Promise<ActionOutcome>,
): void {
  app.post<{ Params: { id: string } }>(
    `/api/containers/:id/${action}`,
    {
      preHandler: [
        validateId,
        requireRole("operator", { action: `container.${action}` }),
      ],
    },
    async (request, reply) => {
      const { id } = request.params;
      // The global gate + requireRole guarantee a user by now.
      const user = request.session.get("user")!;

      let auditId: number;
      try {
        auditId = recordEvent({
          actor: user.username,
          role: user.role,
          action: `container.${action}`,
          target: id,
          outcome: "failure",
          detail: "incomplete",
          ip: request.ip,
        });
      } catch (err) {
        request.log.error({ err }, "audit write failed — refusing action");
        const body: ApiError = { error: "Audit log unavailable" };
        return reply.code(503).send(body);
      }

      try {
        const outcome = await run(id);
        settleAudit(
          request,
          auditId,
          "success",
          outcome.noOp ? "no-op: already in desired state" : undefined,
        );
        const body: ContainerActionResult = { id, action, state: outcome.state };
        return body;
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as { statusCode: number }).statusCode
            : 500;
        const message = err instanceof Error ? err.message : "Action failed";
        settleAudit(request, auditId, "failure", message);
        const body: ApiError = {
          error: statusCode === 404 ? "Container not found" : "Action failed",
          detail: message,
        };
        return reply.code(statusCode === 404 ? 404 : 502).send(body);
      }
    },
  );
}

export async function actionRoutes(app: FastifyInstance): Promise<void> {
  registerAction(app, "start", startContainer);
  registerAction(app, "stop", stopContainer);
  registerAction(app, "restart", restartContainer);
}
