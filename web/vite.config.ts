import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, /api requests are proxied to the Fastify server so the browser
// never deals with CORS. In Docker, VITE_API_TARGET points at the server
// service name on the compose network.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://localhost:4000",
        // Keep the browser's Host (localhost:5173) instead of rewriting it
        // to the target's. The logs route's same-origin check compares Host
        // against the browser's Origin; changeOrigin: true made those
        // disagree and every WebSocket upgrade was rejected.
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
