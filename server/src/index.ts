import Fastify from "fastify";
import cors from "@fastify/cors";
import { containerRoutes } from "./routes/containers.js";
import { pingDocker } from "./docker.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === "production"
        ? true
        : {
            transport: {
              target: "pino-pretty",
              options: { translateTime: "HH:MM:ss" },
            },
          },
  });

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

  await app.listen({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error("Fatal: server failed to start", err);
  process.exit(1);
});
