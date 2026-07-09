import { buildApp } from "./app.js";
import { loadUsers } from "./auth.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  if (loadUsers().length === 0) {
    throw new Error(
      "No users configured — set FLEET_USERS (JSON array) or FLEET_USERS_FILE. " +
        'Generate a hash with: npm run hash-password -- "<password>"',
    );
  }

  const app = await buildApp({
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

  await app.listen({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error("Fatal: server failed to start", err);
  process.exit(1);
});
