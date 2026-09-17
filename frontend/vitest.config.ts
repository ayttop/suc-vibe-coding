import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Dev-only. Not copied into the Docker image (the Dockerfile only copies
// src/, tsconfig*.json, vite.config.ts, index.html), so it never affects
// the production build.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.{ts,tsx}"],
    // Playwright specs live under tests/e2e and run via `playwright test`,
    // not Vitest.
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
  },
});
