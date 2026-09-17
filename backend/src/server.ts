import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { hfAuthMiddleware } from "./auth.js";
import { chatRoute } from "./routes/chat.js";
import { publishRoute } from "./routes/publish.js";
import { modelsRoute } from "./routes/models.js";
import type { AppBindings } from "./types.js";

// Fail-fast in production so the HF Space build surfaces a missing secret
// in the build logs instead of letting the Space start and only blow up on
// the first /api/chat request. In dev we only warn - the secret is often
// absent while iterating on non-agent code.
if (!process.env.OPENROUTER_API_KEY) {
  const isProd = process.env.NODE_ENV === "production";
  const msg =
    "OPENROUTER_API_KEY is not set. " +
    "On Hugging Face Spaces, set it under Settings -> Variables and secrets -> New secret. " +
    "Locally, copy backend/.env.example to backend/.env and fill it in.";
  if (isProd) {
    console.error(`[startup] FATAL: ${msg}`);
    process.exit(1);
  }
  console.warn(`[startup] ${msg}`);
  console.warn("[startup] /api/chat will return 503 until the key is set.");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Production layout after `docker build`:
 *   /app/backend/dist/server.js       (this file)
 *   /app/frontend/dist/               (Vite build output served as static)
 *
 * Dev layout:
 *   backend/src/server.ts             (tsx)
 *   frontend/dist/  (optional)
 */
const STATIC_CANDIDATES = [
  path.resolve(__dirname, "../../frontend/dist"), // production
  path.resolve(__dirname, "../../../frontend/dist"), // just in case
  path.resolve(process.cwd(), "../frontend/dist"), // dev run from backend/
  path.resolve(process.cwd(), "frontend/dist"), // dev run from repo root
];
const STATIC_ROOT =
  STATIC_CANDIDATES.find((p) => existsSync(path.join(p, "index.html"))) ?? null;

const app = new Hono<AppBindings>();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => origin ?? "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

// ── API routes (auth-gated) ───────────────────────────────────────────────
const api = new Hono<AppBindings>();
api.use("*", hfAuthMiddleware());
api.route("/chat", chatRoute);
api.route("/publish", publishRoute);
api.route("/models", modelsRoute);
api.get("/me", (c) => {
  const user = c.get("hfUser");
  if (!user) return c.json({ authenticated: false });
  return c.json({ authenticated: true, user });
});
api.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api", api);

// ── Static frontend ───────────────────────────────────────────────────────
if (STATIC_ROOT) {
  const indexHtml = readFileSync(path.join(STATIC_ROOT, "index.html"), "utf-8");

  app.use(
    "/assets/*",
    serveStatic({
      root: path.relative(process.cwd(), STATIC_ROOT) || ".",
    }),
  );

  app.use("/favicon.ico", serveStatic({ path: path.join(STATIC_ROOT, "favicon.ico") }));

  // Root-level static asset: the default app icon. The host top bar (in the
  // live preview) probes `<origin>/icon.svg`; without this it would hit the SPA
  // fallback below and receive index.html instead of the SVG.
  app.use("/icon.svg", serveStatic({ path: path.join(STATIC_ROOT, "icon.svg") }));

  // SPA fallback for anything that's not /api/*
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.notFound();
    }
    return c.html(indexHtml);
  });
  console.log(`[startup] Serving static frontend from ${STATIC_ROOT}`);
} else {
  app.get("/", (c) =>
    c.json({
      status: "api-only",
      hint: "Frontend dist not found - run `cd frontend && npm run build` or use Vite dev server at :5173",
    }),
  );
  console.log("[startup] No frontend/dist found - API-only mode");
}

const port = Number(process.env.PORT ?? 7860);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`[startup] reachy-mini-vibe-coder listening on :${port}`);
});
