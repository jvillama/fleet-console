import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
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
