import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import cors from "@fastify/cors";
import secureSession from "@fastify/secure-session";
import rateLimit from "@fastify/rate-limit";
import { containerRoutes } from "./routes/containers.js";
import { authRoutes } from "./routes/auth.js";
import { closeAudit, initAudit } from "./audit.js";
import { pingDocker } from "./docker.js";
import type { ApiError, SessionUser } from "./types.js";

declare module "@fastify/secure-session" {
  interface SessionData {
    user: SessionUser;
    issuedAt: number;
  }
}

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
}

/** /api paths reachable without a session. */
const OPEN_API_PATHS = new Set(["/api/health", "/api/login"]);

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

/**
 * Builds the Fastify app with all routes registered, but not listening —
 * index.ts calls listen(); tests drive it via app.inject().
 */
export async function buildApp(
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const secret = process.env.FLEET_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("FLEET_SESSION_SECRET must be set to at least 32 characters");
  }

  const app = Fastify({ logger: opts.logger ?? false });

  // In production the frontend is served from the same origin (or behind
  // the same reverse proxy), so CORS is only open for local dev.
  await app.register(cors, {
    origin: process.env.NODE_ENV === "production" ? false : true,
  });

  await app.register(secureSession, {
    secret,
    salt: "fleet-console-v1", // must be exactly 16 chars; key = pbkdf2(secret, salt)
    cookieName: "session",
    cookie: {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      // Compose serves plain HTTP on a trusted network by default; enable
      // behind TLS termination.
      secure: process.env.FLEET_COOKIE_SECURE === "true",
    },
  });

  await app.register(rateLimit, { global: false });

  initAudit(process.env.AUDIT_DB_PATH ?? "./data/audit.db");
  app.addHook("onClose", async () => closeAudit());

  // Auth gate: every /api route except the open set requires a valid,
  // unexpired session. New routes are therefore protected by default.
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/") || OPEN_API_PATHS.has(path)) return;

    const user = request.session.get("user");
    const issuedAt = request.session.get("issuedAt");
    if (
      !user ||
      typeof issuedAt !== "number" ||
      Date.now() - issuedAt > SESSION_TTL_MS
    ) {
      request.session.delete();
      const body: ApiError = { error: "Unauthorized" };
      return reply.code(401).send(body);
    }
  });

  app.get("/api/health", async () => {
    const dockerReachable = await pingDocker();
    return {
      ok: dockerReachable,
      docker: dockerReachable ? "connected" : "unreachable",
      uptimeSeconds: Math.round(process.uptime()),
    };
  });

  await app.register(authRoutes);
  await app.register(containerRoutes);

  return app;
}
