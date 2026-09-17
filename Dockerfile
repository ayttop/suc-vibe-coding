# syntax=docker/dockerfile:1.7
# ────────────────────────────────────────────────────────────────────────────
# Stage 1 · build the React frontend
# ────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS frontend-builder

WORKDIR /build/frontend

# The frontend has Playwright as a devDep (preview smoke tests, CI only).
# Its postinstall would otherwise download a ~150MB browser during the image
# build - useless here (the image never runs e2e) and a needless failure
# surface. Skip it; the production `npm run build` doesn't touch Playwright.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci || npm install

COPY frontend/tsconfig*.json frontend/vite.config.ts frontend/index.html ./
COPY frontend/src ./src
# Static assets served at the site root (e.g. `/icon.svg` - the default app
# icon the host probes for in the live preview). Vite copies `public/` into
# `dist/` at build time.
COPY frontend/public ./public

RUN npm run build

# ────────────────────────────────────────────────────────────────────────────
# Stage 2 · build the Hono backend
# ────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS backend-builder

WORKDIR /build/backend

COPY backend/package.json backend/package-lock.json* ./
RUN npm ci || npm install

COPY backend/tsconfig.json ./
COPY backend/scripts ./scripts
COPY backend/src ./src

RUN npm run build && npm prune --omit=dev

# ────────────────────────────────────────────────────────────────────────────
# Stage 3 · runtime (node + built assets only)
# ────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# `gettext-base` gives us `envsubst` for the OAuth vars entrypoint.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gettext-base tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Backend runtime (compiled JS + production node_modules)
COPY --from=backend-builder /build/backend/dist           /app/backend/dist
COPY --from=backend-builder /build/backend/node_modules   /app/backend/node_modules
COPY --from=backend-builder /build/backend/package.json   /app/backend/package.json

# Skills are loaded from source markdown at runtime (skill-loader.ts reads
# them from disk). We copy them FROM the backend-builder stage (not the build
# context) so the build-time `sync-daemon-docs.mjs` output is included: the
# freshly fetched `daemon/*.md` canonical docs and the SDK pin substituted into
# SKILL.md.
COPY --from=backend-builder /build/backend/src/agent/skills /app/backend/dist/agent/skills

# Frontend static build - server.ts detects this folder automatically.
COPY --from=frontend-builder /build/frontend/dist /app/frontend/dist

# HF OAuth variables entrypoint
COPY docker-entrypoint.d /app/docker-entrypoint.d
RUN chmod +x /app/docker-entrypoint.d/*.sh

ENV NODE_ENV=production \
    PORT=7860 \
    REQUIRE_HF_AUTH=1

EXPOSE 7860

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.d/entrypoint.sh"]
CMD ["node", "/app/backend/dist/server.js"]
