import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import cors from "@fastify/cors";
import { containerRoutes } from "./routes/containers.js";
import { pingDocker } from "./docker.js";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
}

/**
 * Builds the Fastify app with all routes registered, but not listening —
 * index.ts calls listen(); tests drive it via app.inject().
 */
export async function buildApp(
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  // In production the frontend is served from the same origin (or behind
  // the same reverse proxy), so CORS is only open for local dev.
  await app.register(cors, {
    origin: process.env.NODE_ENV === "production" ? false : true,
  });

  app.get("/api/health", async () => {
    const dockerReachable = await pingDocker();
    return {
      ok: dockerReachable,
      docker: dockerReachable ? "connected" : "unreachable",
      uptimeSeconds: Math.round(process.uptime()),
    };
  });

  await app.register(containerRoutes);

  return app;
}
