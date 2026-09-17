#!/usr/bin/env node
// Sync canonical Reachy Mini docs from the daemon repo at build time.
//
// Why: the vibe-coder ships an agent skill that teaches an LLM how to build a
// Reachy Mini browser app. The robot knowledge and the JS SDK surface live in
// `pollen-robotics/reachy_mini`. Hand-copying them here drifts. Instead we pull
// the canonical markdown from the daemon `main` branch on every build and we
// resolve the canonical SDK pin from the npm dist-tags, then substitute it into
// the generated app template (SKILL.md).
//
// This runs inside the Docker `backend-builder` stage (via `npm run build`) and
// locally (`npm run sync-docs`). It is network-tolerant: if the registry or
// raw.githubusercontent is unreachable, it keeps the committed snapshot and
// exits 0 so the build never breaks.

import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(
  __dirname,
  "../src/agent/skills/reachy-mini-app",
);
const DAEMON_DIR = path.join(SKILL_DIR, "daemon");
const SKILL_HUB = path.join(SKILL_DIR, "SKILL.md");

const DAEMON_REPO = "pollen-robotics/reachy_mini";
// We track `main` for docs on purpose - do NOT switch this to a release
// tag. The canonical app docs (APP_CREATION_GUIDE.md, javascript-sdk.md,
// skills/) are maintained ONLY on `main`; release tags predate them (e.g.
// `ts/APP_CREATION_GUIDE.md` 404s at the `v1.8.0` tag). Pinning to a tag
// would make the fetch fail and silently fall back to the stale committed
// snapshot. The SDK itself is still pinned to the exact stable 1.8.0 in
// SKILL.md (see REPO_CANONICAL_PIN); this docs-from-main + pinned-SDK split
// is deliberate. TODO(single-source-of-truth): once upstream ships a
// version-tagged canonical bare-HTML template/app, point this at that tag
// and generate the template from it. Override with DAEMON_DOCS_REF.
const DAEMON_REF = process.env.DAEMON_DOCS_REF || "main";
const RAW_BASE = `https://raw.githubusercontent.com/${DAEMON_REPO}/${DAEMON_REF}`;

const SDK_PKG = "@pollen-robotics/reachy-mini-sdk";
const NPM_REGISTRY = `https://registry.npmjs.org/${SDK_PKG}`;
const JSDELIVR_META = `https://data.jsdelivr.com/v1/packages/npm/${SDK_PKG}`;

// Canonical daemon docs to mirror. `remote` is relative to the repo root,
// `local` is the filename written under `daemon/` (auto-discovered by the
// skill-loader, exposed to the agent via `read_skill_doc`).
const DOCS = [
  // The single source of truth for building a JS app. Its bare-HTML + CDN
  // section is the pattern this vibe-coder uses; its robotics best-practices
  // section covers safe teardown.
  { remote: "ts/APP_CREATION_GUIDE.md", local: "APP_CREATION_GUIDE.md" },
  // JS SDK runtime reference - the authoritative method/event names.
  { remote: "docs/source/SDK/javascript-sdk.md", local: "javascript-sdk.md" },
  // Top-level orientation hub.
  { remote: "AGENTS.md", local: "AGENTS.md" },
  // Robot-knowledge skills (behaviour, motion, interaction, low-level access).
  { remote: "skills/motion-philosophy.md", local: "motion-philosophy.md" },
  { remote: "skills/interaction-patterns.md", local: "interaction-patterns.md" },
  { remote: "skills/control-loops.md", local: "control-loops.md" },
  { remote: "skills/rest-api.md", local: "rest-api.md" },
  { remote: "skills/safe-torque.md", local: "safe-torque.md" },
];

const FETCH_TIMEOUT_MS = 15_000;

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

// ── semver (prerelease-aware) ───────────────────────────────────────────────
// Minimal comparator: numeric core dominates; a prerelease ranks below its own
// release but we only ever compare tags against each other, so the standard
// semver precedence rules are enough.
function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v).trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

function isStableRelease(v) {
  const p = parseSemver(v);
  return p !== null && p.prerelease === null;
}

// ── canonical pin ────────────────────────────────────────────────────────────
// The exact STABLE version we ship. This is the repo's canonical,
// end-to-end-validated release (see APP_CREATION_GUIDE §10, shared by the
// reference apps `reachy_mini_minimal_conversation`, `reachy_mini_emotions`,
// `reachy_mini_telepresence`).
//
// We deliberately pin an explicit stable string instead of auto-bumping to
// whatever npm currently tags, because:
//   - The old logic (`max(latest, rc)`) could silently ship a release
//     candidate (`x.y.z-rc*`) or, via other tags, a dev build on the next
//     rebuild. Apps generated here must be reproducible and boot-tested.
//   - npm `latest` sometimes races ahead of the version the daemon docs and
//     host shell are validated against. When that happens we prefer this
//     repo canonical and only WARN (see `main`), so a human bumps this
//     constant intentionally after re-testing against a live robot.
//
// To upgrade: change this string to the new stable release AFTER the three
// reference apps above have moved to it.
const REPO_CANONICAL_PIN = "1.8.0";

// ── latest-stable resolution (advisory only) ─────────────────────────────────
// Resolve the npm `latest` dist-tag EXACTLY. Stable-only: an RC / dev / `main`
// tag is never selected. Used solely to warn when a newer stable exists; it
// never overrides REPO_CANONICAL_PIN.
async function resolveLatestStablePin() {
  let tags = null;
  try {
    const meta = await fetchJson(NPM_REGISTRY);
    tags = meta?.["dist-tags"] ?? null;
  } catch (err) {
    console.warn(`[sync-docs] npm registry unreachable (${err.message}), trying jsDelivr`);
  }
  if (!tags) {
    try {
      const meta = await fetchJson(JSDELIVR_META);
      tags = meta?.tags ?? null;
    } catch (err) {
      console.warn(`[sync-docs] jsDelivr unreachable (${err.message})`);
    }
  }
  if (!tags) return null;
  const latest = tags.latest ?? null;
  if (!latest || !isStableRelease(latest)) {
    console.warn(
      `[sync-docs] npm 'latest' (${latest ?? "none"}) is missing or not a ` +
        `stable release - ignoring (never falling back to rc/dev/main).`,
    );
    return null;
  }
  return latest;
}

// ── doc sync ────────────────────────────────────────────────────────────────
function buildHeader(remote, pin) {
  const stamp = new Date().toISOString().slice(0, 10);
  const pinLine = pin ? ` · canonical SDK pin: \`${pin}\`` : "";
  return (
    `> **Auto-fetched** from [\`${DAEMON_REPO}@${DAEMON_REF}\`](https://github.com/${DAEMON_REPO}/blob/${DAEMON_REF}/${remote}) ` +
    `on ${stamp}${pinLine}.\n` +
    `> Do not edit by hand - run \`npm run sync-docs\` to refresh.\n\n`
  );
}

async function syncDocs(pin) {
  await mkdir(DAEMON_DIR, { recursive: true });
  let fetched = 0;
  let kept = 0;
  for (const { remote, local } of DOCS) {
    const dest = path.join(DAEMON_DIR, local);
    try {
      const body = await fetchText(`${RAW_BASE}/${remote}`);
      await writeFile(dest, buildHeader(remote, pin) + body, "utf-8");
      fetched++;
      console.log(`[sync-docs] ✓ ${remote} -> daemon/${local}`);
    } catch (err) {
      // Keep whatever snapshot is already committed; never break the build.
      console.warn(
        `[sync-docs] ✗ ${remote} (${err.message}) - keeping committed snapshot`,
      );
      kept++;
    }
  }
  return { fetched, kept };
}

// ── pin substitution in SKILL.md ────────────────────────────────────────────
// Rewrites every `@pollen-robotics/reachy-mini-sdk@<version>` occurrence (the
// CDN import and the API reference) to the resolved canonical pin.
async function substitutePin(pin) {
  if (!pin) {
    console.warn("[sync-docs] no canonical pin resolved - skipping SKILL.md pin update");
    return;
  }
  let hub;
  try {
    hub = await readFile(SKILL_HUB, "utf-8");
  } catch (err) {
    console.warn(`[sync-docs] cannot read SKILL.md (${err.message}) - skipping pin update`);
    return;
  }
  const pinRe = /(@pollen-robotics\/reachy-mini-sdk@)[^/"'\s]+/g;
  const before = hub;
  hub = hub.replace(pinRe, `$1${pin}`);
  if (hub === before) {
    console.log("[sync-docs] SKILL.md already pinned to the canonical version");
    return;
  }
  await writeFile(SKILL_HUB, hub, "utf-8");
  console.log(`[sync-docs] SKILL.md SDK pin updated to ${pin}`);
}

async function main() {
  console.log("[sync-docs] syncing canonical daemon docs + SDK pin…");
  // The pin we ship is always the repo canonical stable string. This keeps
  // the doc headers and SKILL.md import in lockstep with the daemon doc
  // bodies (which reference the same stable version), so there is no
  // header-says-X / body-says-Y drift.
  const pin = REPO_CANONICAL_PIN;
  const latestStable = await resolveLatestStablePin();
  if (latestStable && latestStable !== pin) {
    console.warn(
      `[sync-docs] npm 'latest' is ${latestStable} but we pin the repo ` +
        `canonical ${pin} (APP_CREATION_GUIDE §10). This is intentional: ` +
        `bump REPO_CANONICAL_PIN by hand once the reference apps move to ` +
        `${latestStable} and it's re-tested against a live robot.`,
    );
  } else {
    console.log(`[sync-docs] shipping canonical SDK pin ${pin}`);
  }
  const { fetched, kept } = await syncDocs(pin);
  await substitutePin(pin);
  console.log(`[sync-docs] done (fetched ${fetched}, kept ${kept}/${DOCS.length}).`);
}

main().catch((err) => {
  // Last-resort guard: still exit 0 so a transient failure never breaks build.
  console.warn(`[sync-docs] unexpected error: ${err?.stack || err}`);
  process.exit(0);
});
