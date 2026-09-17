import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev: Vite serves the React app on :5173 and proxies `/api/*` to the
 * Hono backend on :7860. In production the same Hono server serves the
 * static build from `frontend/dist` (see `backend/src/server.ts`).
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:7860",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
