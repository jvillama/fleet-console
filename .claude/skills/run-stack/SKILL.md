---
name: run-stack
description: Build and run the fleet-console stack (docker compose or dev mode), wait for the health endpoint, and report the URL. Use when asked to run, start, or verify the app end-to-end.
---

Run the fleet-console app and confirm it is actually healthy before reporting success.

## Full stack (default)

1. Confirm the Docker daemon is reachable (`docker info`). If not, stop and tell the user to start Docker Desktop — nothing below works without it.
2. From the repo root run `docker compose up --build -d`.
3. Poll the health endpoint through nginx until it responds or ~60s elapse:
   `curl -s http://localhost:8080/api/health`
   Healthy response: `{"ok":true,"docker":"connected",...}`. If `docker` is `"unreachable"`, the server container can't see the host socket — check the `/var/run/docker.sock` mount in docker-compose.yml.
4. Report: the app is at **http://localhost:8080**, and quote the health JSON. The compose file also starts `demo-nginx` and `demo-redis` so the dashboard has rows.
5. To stop: `docker compose down`.

## Dev mode (when the user is iterating on code)

Run both watchers in the background:
- `cd server && npm run dev` — Fastify on :4000 (tsx watch)
- `cd web && npm run dev` — Vite on :5173, proxies `/api` to :4000

Verify with `curl -s http://localhost:4000/api/health`, then report the app is at **http://localhost:5173**. Dev mode still needs the Docker daemon running for real data.
