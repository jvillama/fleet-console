import type { FastifyInstance } from "fastify";
import {
  getContainerStats,
  getFleetOverview,
  listContainers,
} from "../docker.js";
import type { ApiError } from "../types.js";

/**
 * Phase 1 routes: read-only fleet visibility.
 * Phase 2 will add POST /containers/:id/start|stop|restart and log streaming.
 */
export async function containerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/overview", async () => {
    return getFleetOverview();
  });

  app.get("/api/containers", async () => {
    return listContainers();
  });

  app.get<{ Params: { id: string } }>(
    "/api/containers/:id/stats",
    async (request, reply) => {
      const { id } = request.params;

      // Container ids are hex; names are alphanumeric with ._- . Reject
      // anything else before it reaches the Docker API.
      if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
        const body: ApiError = { error: "Invalid container id" };
        return reply.code(400).send(body);
      }

      try {
        return await getContainerStats(id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as { statusCode: number }).statusCode
            : 500;
        const body: ApiError = {
          error:
            statusCode === 404 ? "Container not found" : "Stats unavailable",
        };
        if (err instanceof Error) body.detail = err.message;
        return reply.code(statusCode === 404 ? 404 : 502).send(body);
      }
    },
  );
}
