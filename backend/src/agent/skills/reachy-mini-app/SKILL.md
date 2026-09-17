---
name: reachy-mini-app
description: Build a tiny static browser app for the Reachy Mini robot, previewable live and publishable to a Hugging Face Space in one click. 3 files, no build step, no npm, no server, no API keys beyond HF OAuth. Same artifact runs standalone, in the vibe-coder preview, and embedded in any Reachy Mini host (mobile app or host shell) via the current protocol-v1 handshake (`embed:ready`/`host:init`, creds in `#creds=<base64>`). Covers the app template plus concept-level robot knowledge (DOF, safety, motion philosophy, interaction patterns, daemon REST/WebSocket API).
---

# Build a tiny static Reachy Mini web app

This vibe coder produces **one kind of artifact**: a small static HF
Space that runs in a sandboxed preview iframe and can be published to
Hugging Face in one click.

The same 3 files run unchanged in **two** code paths (three contexts):

1. **Standalone** - opened directly, or in the vibe-coder preview.
   `main.js` calls `mountHost()`; the host shell owns HF OAuth + the
   robot picker + the top bar. In the preview the vibe-coder seeds the
   HF token it already holds into `sessionStorage`, so `authenticate()`
   resolves from cache (no OAuth popup) and the shell goes straight to
   the picker ("no robot online" in preview).
2. **Embedded in any Reachy Mini host** (`?embedded=1#creds=<base64>`,
   mobile app or host shell). `main.js` calls `connectToHost()`; the SDK
   runs the protocol-v1 handshake (`embed:ready` → `host:init`) and hands
   back a live, awake robot session.

The SDK owns both paths - the app just picks the entrypoint. There is no
hand-rolled auth, picker, or handshake.

## Hard constraints (non-negotiable)

| Dimension | Value |
|---|---|
| HF Space `sdk` | `static` |
| Auth | Hugging Face OAuth only (auto-injected on Spaces) |
| Files | **3** required: `index.html`, `main.js`, `README.md` (+ optional `icon.svg`, see [App icon convention](#app-icon-convention)) |
| Build step | **none** - HF serves files as-is from the repo root |
| Dependencies | ReachyMini JS SDK + anything loadable from a public CDN (jsdelivr, esm.sh, unpkg). **No npm, no package.json, no bundler.** |
| Server-side code | **none** - no Dockerfile, no Nginx, no backend |
| Secrets | **none** - only HF OAuth (client ID auto-injected server-side) |

Violating any of these breaks either the live preview, the publish
flow, or both. If a user request does not fit these constraints
(e.g. "voice conversation with an LLM", "connect to OpenAI Realtime",
"read from a private API"), **push back** and propose a simpler shape
that does.

**Code style - keep comments minimal.** Only comment non-obvious intent,
trade-offs, or constraints. Do NOT add comments that merely narrate what
the code does (`// connect to robot`, `// set up handler`). Prefer clear
names over comments.

## Reachy UI kit (optional design tokens)

Optional styling guidance you can put in your own `<style>` (there is no
prebuilt stylesheet to copy). If you want the app to look on-brand, use
these CSS custom properties (design tokens) from the Reachy Mini mobile
theme instead of inventing colors or hardcoding hex.

- **Tokens**: a light palette lives in `:root`, the dark palette in
  `[data-theme="dark"]`. Only color tokens flip between themes; radii,
  fonts and geometry are shared. Read tokens, never hardcode hex:
  - Surfaces/text: `--background`, `--foreground`, `--surface`,
    `--surface-2`, `--card`, `--muted-foreground`, `--border`.
  - Brand: `--primary` (Reachy orange `#ff9500` light / `#ff9f0a`
    dark), `--primary-foreground`, `--accent`, `--ring`,
    `--destructive`.
  - Shape/typography: `--radius` (12px) + `--radius-sm..2xl`,
    `--font-sans` (Inter), `--font-display` (Plus Jakarta Sans),
    `--shadow-card`, `--shadow-elev`, `--shadow-focus`.
- **Utility classes**: `.btn` (+ `.btn.primary`, `.btn.ghost`,
  `.btn.danger`), `.card`, `.row` (+ `.row.selected`), `.field` +
  `.input`, `.chip`, `.toast` (+ `.toast.success`, `.toast.error`).
  All token-driven, so they theme for free.

**Honor the host theme.** The host owns the palette. In standalone,
`mountHost()` sets `<html data-theme>` itself. In embed, apply
`handle.theme` and follow `handle.onThemeChange(...)` by writing
`document.documentElement.dataset.theme`. Key your dark rules off
`[data-theme="dark"]`; do **not** hardcode a single theme or read
`prefers-color-scheme` to override the host.

## What this mode can do well

- HF OAuth login and robot session management via the JS SDK.
- Head, body and antenna motion (`setHeadRpyDeg`, `setBodyYawDeg`, `setAntennasDeg`).
- Live WebRTC video stream (`attachVideo`).
- Preset robot sound playback (`playSound`).
- Raw data-channel commands (`sendRaw`) for low-level motor targets.
- Web Audio API: analyse the robot mic via `AnalyserNode`, synthesise
  tones, react to audio energy (RMS, frequency bins).
- Any browser API: Canvas, WebGL via three.js from a CDN, Gamepad,
  DeviceMotion, `fetch` to public CORS-friendly endpoints, etc.
- Persistence via `localStorage`.

## What this mode cannot do (say no, propose alternatives)

- Voice conversation with an LLM (ASR + LLM + TTS). Requires a CORS
  proxy and server-side secrets - **out of scope here**. Suggest a
  button-driven or sensor-driven alternative instead.
- Any call to `api.openai.com`, `api.anthropic.com`, `api.elevenlabs.com`,
  etc. No CORS proxy available.
- Multi-user shared state, databases, webhooks, cron jobs.

## How to build the app (deduce it from the docs - no copy-paste template)

There is **no ready-made starter app** here, on purpose. Build the 3 files by
reading the authoritative, auto-synced docs and applying the rules below. The
goal is that you *derive* the app from the docs, not recite a fixed gabarit.

**Read these FIRST** (via `read_skill_doc`), then write the files:

- `daemon/APP_CREATION_GUIDE` - §11.5 "bare HTML + CDN (Modern)" is the exact
  shape to follow (no bundler, host entries from the CDN, the
  `?embedded=1` dispatch, the `__OAUTH_CLIENT_ID__` block, README
  frontmatter). §4/§5 document `mountHost()` / `connectToHost()`; §13 the
  host protocol.
- `daemon/javascript-sdk` - exact SDK method/event names.
- `robot-overview` / `robot-motion` / `robot-interaction` / `robot-rest-api`
  - what the robot can do and how to move it well.

Then produce exactly **3 files**, honouring these vibe-coder rules (they cover
what the upstream doc's *Vite* default path does NOT, because we ship raw
bare-HTML/CDN):

### `README.md`
HF Space frontmatter with `sdk: static`, `hf_oauth: true`, and the tag
`reachy_mini_js_app` (plus `title`, `emoji`, `short_description`). No
`package.json`, no build.

### `index.html`
- In `<head>`, BEFORE anything imports the SDK, the **`process` shim** - the
  CDN host bundle references `process.env.NODE_ENV` and throws
  `ReferenceError: process is not defined` without it:
  ```html
  <script>
    globalThis.process = globalThis.process || { env: {} };
    globalThis.process.env = globalThis.process.env || {};
    globalThis.process.env.NODE_ENV = globalThis.process.env.NODE_ENV || "production";
  </script>
  ```
- The HF OAuth `window.huggingface.variables` `__OAUTH_CLIENT_ID__` block from
  APP_CREATION_GUIDE §3.1 (needed for OAuth on the deployed Space).
- Two mount points, one per mode (they are NOT redundant, but they are
  **mutually exclusive** - each mode removes the other, see dispatch):
  - `<div id="root"></div>` - the target `mountHost()` renders the host shell
    into, used ONLY in the **standalone** mode.
  - `<main id="app" hidden>` - YOUR app surface, used ONLY in the **embed**
    mode. Ships **hidden**; ALL your interactive UI (buttons, `<video>`,
    layout) lives here and is rendered + revealed by the embed branch.

  Why remove the unused one: in embed mode `#root` stays empty (no mountHost),
  and if your CSS makes it full-screen it paints OVER `#app` → black screen. In
  standalone the host wipes/owns the page. So the dispatch drops `#root` in
  embed and `#app` in standalone, leaving exactly one live surface. Do NOT
  style `#root` and `#app` to both cover the viewport at once.
- `<script type="module" src="./main.js"></script>`.

### `main.js` - dispatch (the only correct control flow)
Import the host entries from jsDelivr, pinned to the **exact** stable `1.8.0`
(APP_CREATION_GUIDE §10 - never a range, RC, or dev tag). In the raw browser
you MUST use the full built entry URLs (bare specifiers only work under a
bundler):

```js
// Embed when the host asked for it (`?embedded=1`) OR when creds were handed
// off in the fragment (`#creds=…`). The fragment check also makes the app work
// under the vibe-coder live preview, where the host embeds the app from a
// blob: URL that has no query string but does carry `#creds=…`.
const params = new URLSearchParams(location.search);
const isEmbed = params.get("embedded") === "1" || location.hash.includes("creds=");
if (isEmbed) {
  const { connectToHost } = await import(
    "https://cdn.jsdelivr.net/npm/@pollen-robotics/reachy-mini-sdk@1.8.0/host/dist/entry/embed.js"
  );
  const handle = await connectToHost(); // decodes #creds, wakes the robot

  // REQUIRED - reveal + render, or the user gets a BLACK SCREEN.
  // connectToHost() reports `live` then resolves; at `live` the host removes
  // its connecting overlay and makes THIS iframe visible. The host NEVER
  // renders your app UI and NEVER un-hides `#app`. You must:
  //
  // FIRST remove `#root`. In embed mode mountHost never runs, so `#root` is an
  // EMPTY leftover - but any full-screen style on it (e.g.
  // `#root{position:fixed;inset:0}`) makes that empty box paint OVER `#app`
  // (a positioned element paints above its static siblings), so the UI is
  // present in the DOM yet the screen is black. Dropping it is the fix.
  document.getElementById("root")?.remove();
  const app = document.getElementById("app");
  app.hidden = false;                    // #app ships hidden in index.html
  renderApp(app, handle.reachy);         // build your buttons/video/layout here

  // Apply the host theme so you're not stuck on a dark (black) canvas, and
  // follow live switches. Your CSS keys its dark palette off <html data-theme>.
  const applyTheme = (m) =>
    document.documentElement.setAttribute("data-theme", m === "dark" ? "dark" : "light");
  applyTheme(handle.theme);
  handle.onThemeChange(applyTheme);
  handle.onLeave(() => {/* stop timers / return-to-pose */});
} else {
  // Standalone: the host shell owns the page. Drop `#app` so only the host
  // target `#root` remains (mode-exclusive surfaces: exactly one per mode).
  document.getElementById("app")?.remove();
  const { mountHost } = await import(
    "https://cdn.jsdelivr.net/npm/@pollen-robotics/reachy-mini-sdk@1.8.0/host/dist/entry/auto.js"
  );
  mountHost({
    appName: "…",
    appEmoji: "🤖",
    // Prefer the in-VFS icon (agent-generated or user-provided) so the live
    // preview shows the REAL icon; falls back to the served `icon.svg` at the
    // Space root. Copy this line verbatim.
    appIconUrl: window.__REACHY_MINI_ICON_URL__ || "icon.svg",
    // Lets the vibe-coder preview point the host's embed iframe at the REAL
    // app (a same-origin blob) so a live session runs in preview. In
    // production this global is undefined, so the host uses its default
    // `/?embedded=1` — copy this line verbatim, do NOT set it yourself.
    embedPath: window.__REACHY_MINI_EMBED_URL__ || undefined,
  });
}
```

**Script order (avoid `ReferenceError: Cannot access 'X' before
initialization`).** `main.js` is an ES module, so top-level `const`/`let` live
in a Temporal Dead Zone until their line runs. Therefore:
- Declare ALL module state (`const`/`let`: `targetPose`, `controlLoopActive`,
  handles, config…) BEFORE the functions/loops that read it.
- Start the app LAST: define `renderApp`, handlers and the control loop as
  functions, then call `main()` / kick off `requestAnimationFrame`/`setInterval`
  at the very END of the script, after every declaration.
- Never reference a variable inside its own initializer, and don't let a
  function invoked during boot read a `const` declared further down.

**Commanding head/antenna motion - THE safe pattern (avoid "woke up then
stopped").** `setHeadRpyDeg`/`setTarget` is a streaming API. The failure mode
that keeps happening: a `requestAnimationFrame` loop that streams a pose EVERY
frame. Even correctly gated on `is_move_running`, the instant the wake-up move
ends the loop streams your default `(0,0,0)` ~60Hz and **pins the head to
neutral** → the robot "wakes then stops dead". Gating only avoids the conflict
*during* the move; it does NOT prevent the neutral-pin *after* it.

Rules that make this impossible by construction:
1. **NEVER run a rAF/setInterval loop that streams a fixed pose.** Send head
   commands ONLY from input handlers (a throttled `pointermove`), so an idle
   app sends NOTHING and can never pin a pose.
2. **Seed your target from the REAL pose** on the first `state` event
   (`e.detail.head` is a flat 4×4 → `matrixToRpy`), never from `(0,0,0)`.
3. **Skip while `is_move_running`** so you never fight the wake trajectory.
4. On release, do at most ONE explicit send (or nothing) - never resume a
   continuous stream.

Copy this shape (joystick example) - handlers-only, no streaming loop:

```js
import { matrixToRpy } from "https://cdn.jsdelivr.net/npm/@pollen-robotics/reachy-mini-sdk@1.8.0/+esm";

function renderApp(app, robot) {
  let pose = null;            // null until we know the real pose - seed, not (0,0,0)
  let moveRunning = true;     // wake move is running at connect; wait it out
  let lastSent = 0;
  robot.addEventListener("state", (e) => {
    moveRunning = e.detail.is_move_running;
    if (!pose) pose = matrixToRpy(e.detail.head); // {roll,pitch,yaw} deg
  });
  const send = () => {
    if (!pose || moveRunning) return;             // don't fight the wake, don't snap
    const now = performance.now();
    if (now - lastSent < 33) return;              // throttle ~30Hz
    lastSent = now;
    robot.setHeadRpyDeg(pose.roll, pose.pitch, pose.yaw);
  };
  // Update `pose` from pointer input, then send ONCE per move - no rAF stream.
  app.querySelector("#joystick").addEventListener("pointermove", (ev) => {
    if (!pose) return;
    pose.yaw = /* map ev → deg */ 0;
    pose.pitch = /* map ev → deg */ 0;
    send();
  });
}
```

Do **not** hand-roll OAuth, a sign-in gate, a robot picker, or the
`embed:ready`/`host:init` handshake - the SDK owns all of it. Do **not**
`new ReachyMini()` / `robot.login()` / `robot.connect()` yourself.

### Preview
The vibe-coder preview seeds the HF token into `sessionStorage` and runs the
**standalone `mountHost()`** path, so it shows the real host shell (sign-in
resolved from cache, then the robot picker). It also runs a **live session**:
the preview sets `window.__REACHY_MINI_EMBED_URL__` to a same-origin blob of
your app, so picking your listed robot embeds the REAL app and completes the
full host flow (picker -> link -> session -> wake-up), connecting to the robot
over HF central signaling. There is **no preview branch** to write: just copy
the `embedPath: window.__REACHY_MINI_EMBED_URL__ || undefined` line into your
`mountHost()` call, keep the `#creds=` embed detection, and do NOT read
`window.__REACHY_MINI_PREVIEW_TOKEN__` (obsolete).

### App icon (optional)
Drop a square `icon.svg` (>=256x256, <50KB) at the repo root (served at
`/icon.svg`). Do NOT use a `public/` folder - `sdk: static` serves the repo
root as-is; the README `emoji:` is the fallback.

You usually do NOT need to create one: on publish, the vibe-coder auto-adds a
default "reachy simple" `icon.svg` (the model glyph from the host picker) when
the app doesn't ship its own. Only author an `icon.svg` when you want a
custom, app-specific icon - it takes precedence and is never overwritten.

**Better: generate a dedicated icon with the `generate_app_icon` tool.** When
the app concept is clear (or the user asks for an icon), call
`generate_app_icon` with a short, vivid Reachy-themed `prompt` derived from the
app (e.g. a joystick game -> "a cheerful Reachy Mini robot playing a joystick
game"). It BLOCKS ~60s while a real sticker is generated, writes it to
`icon.svg` (shown in the preview top bar + committed on publish), and shows the
sticker in the chat. It is **re-runnable** (call again to regenerate) and
**robust**: on timeout/quota/failure it keeps the default icon and tells you -
just relay that to the user and offer to retry. It's optional; skip it if the
user doesn't want a custom icon.


## Robot knowledge chapters (load on demand)

These are concept-level docs about the robot itself, not about the web
app plumbing. Load them via `read_skill_doc` when the user asks *what
the robot can do* or *how it should behave*.

- [robot-overview.md](robot-overview.md): hardware DOF, safety ranges,
  motor names, interpolation methods, "must-know" non-negotiables for
  browser apps. **Start here when building anything new.**
- [robot-motion.md](robot-motion.md): `goto()` vs `setTarget()` - the
  defining decision for any interactive app. Decision tree +
  anti-patterns.
- [robot-interaction.md](robot-interaction.md): antennas-as-buttons,
  head-as-joystick, no-GUI patterns. Useful when the user wants games,
  physical interactions, or minimal UI.
- [robot-rest-api.md](robot-rest-api.md): daemon HTTP + WebSocket
  endpoints. Usually you use the JS SDK; read this when you need
  lower-level access or a debug dashboard.

### Canonical daemon docs (auto-fetched at build, `daemon/` subfolder)

These are pulled verbatim from `pollen-robotics/reachy_mini@main` on every
build (see `scripts/sync-daemon-docs.mjs`), so they are always the freshest
upstream truth. Prefer them over the condensed chapters above when you need
exact, current detail. Load via `read_skill_doc`:

- [daemon/javascript-sdk.md](daemon/javascript-sdk.md): **authoritative** JS
  SDK method/event reference (the exact, current names: `setHeadRpyDeg`,
  `setAntennasDeg`, `setBodyYawDeg`, lifecycle, events). Check here whenever
  unsure about an API name.
- [daemon/APP_CREATION_GUIDE.md](daemon/APP_CREATION_GUIDE.md): the upstream
  single source of truth. Look for its **bare HTML + CDN (no bundler)** section
  - the pattern this vibe-coder uses - and its **robotics best-practices /
  safe-teardown** section.
- [daemon/AGENTS.md](daemon/AGENTS.md): upstream orientation hub.
- [daemon/motion-philosophy.md](daemon/motion-philosophy.md),
  [daemon/interaction-patterns.md](daemon/interaction-patterns.md),
  [daemon/control-loops.md](daemon/control-loops.md),
  [daemon/rest-api.md](daemon/rest-api.md),
  [daemon/safe-torque.md](daemon/safe-torque.md): robot-behaviour knowledge.

> **Important - what applies here.** The upstream guide's default path uses a
> TypeScript + Vite + `npm install` build toolchain. **Ignore the build
> toolchain only** - this vibe-coder produces exactly **3 files, no bundler,
> no npm** (see Hard constraints). Everything else applies verbatim, and in
> particular the **host API does apply**: use `mountHost()` (standalone) and
> `connectToHost()` (embed) via the SDK's CDN host entries, exactly as the
> §11.5 "bare HTML + CDN (Modern)" variant and `marionette-experimental` do.
> **"No bundler" does NOT mean "no host API".** The preview is NOT a special
> case: it runs the same `mountHost()` standalone path, with the vibe-coder
> seeding the HF token into `sessionStorage` so auth resolves from cache. Do
> **not** re-implement OAuth, the picker, or the
> `embed:ready`/`host:init`/`#creds=` handshake by hand.

## Things you should NOT do

- Do **not** create a `package.json`, `tsconfig.json`, `vite.config.*`,
  `Dockerfile`, `nginx.conf`, `docker-entrypoint.d/*`, or any `.ts`
  file. The preview iframe does not run a bundler; these files would be
  dead weight and potentially break the HF Space build.
- Do **not** add a build step. HF `sdk: static` serves files verbatim.
- Do **not** create a `public/` folder for assets. That's a Vite /
  bundler convention and it doesn't apply to `sdk: static` apps:
  the repo root IS the served folder, so anything you put inside
  `public/` would be reachable at `/public/<file>` (which is wrong)
  instead of `/<file>` (which is right). Put `icon.svg`, screenshots,
  and any other static asset directly at the repo root next to
  `index.html`. See [App icon convention](#app-icon-convention).
- Do **not** add OpenAI, ElevenLabs, Anthropic, or any other API call.
  They all need a CORS proxy and server-side secrets, which is
  explicitly out of scope for this vibe coder.
- Do **not** rebuild the ReachyMini JS SDK; it handles HF auth,
  signaling and WebRTC negotiation. Import the published npm package
  `@pollen-robotics/reachy-mini-sdk` from jsDelivr's `/+esm` endpoint
  (no bundler). Do **not** pin to a git branch or the legacy single-file
  `gh/.../reachy-mini.js` build.
- Do **not** call `attachVideo(ui.video)` AFTER `startSession()`. The
  remote video track is published during the SDP exchange inside
  `startSession`. If the `<video>` element isn't already attached by
  then, the track has nowhere to go and the element stays black.
- Do **not** flip to "ready" on `startSession()` resolve. The session
  can resolve before video and data channel are actually flowing.
  Listen to the `"streaming"` event instead - it is the authoritative
  "live now" signal.
- Do **not** rely on `window.huggingface.variables` for OAuth on a
  deployed Space unless the Space uses `sdk: static` + `hf_oauth: true`
  (which it always should here).
- Do **not** hand-roll the host/embed handshake, a sign-in gate, or a
  robot picker. Use `mountHost()` (standalone) and `connectToHost()`
  (embed): the SDK owns OAuth, the picker, the top bar, and the
  `embed:ready` / `host:init` / `#creds=` protocol. Hand-copying it
  drifts out of sync with the daemon.
- Do **not** remove the `process` shim or the host `modulepreload`
  tags from `<head>`. The CDN host bundle references
  `process.env.NODE_ENV` and throws `ReferenceError: process is not
  defined` on import without the shim.
- Do **not** leave `#app` hidden or forget to render in the embed branch -
  that is a **black screen**. After `await connectToHost()`, the host makes
  the iframe visible and drops its overlay; if you haven't `app.hidden = false`
  + rendered your UI into `#app` (and applied `handle.theme`), the user sees a
  black canvas. Build ALL app UI in the embed branch, not the standalone one.
- Do **not** call `robot.login()` / `robot.logout()`, `new ReachyMini()`,
  or `robot.connect()` yourself. `mountHost()` (standalone) and
  `connectToHost()` (embed) own the entire auth/session lifecycle. The
  vibe-coder preview also uses `mountHost()` - it just pre-seeds the HF
  token into `sessionStorage`, so there is no preview-specific code to
  write.
- Do **not** add a preview-only code branch or read
  `window.__REACHY_MINI_PREVIEW_TOKEN__` (obsolete). The ONLY preview hook is
  the single `embedPath: window.__REACHY_MINI_EMBED_URL__ || undefined` line in
  your `mountHost()` call (a no-op in production); everything else is the same
  standalone `mountHost()` / embedded `connectToHost()` path.
- Do **not** invent a custom postMessage protocol. If you need extra
  host signalling, use the SDK handle (`handle.setAppState(...)`,
  `handle.requestLeave()`, `handle.onLeave(...)`) - do not post raw
  messages or rename the typed ones (see `ts/host/src/lib/protocol.ts`).

## Host protocol & SDK reference (single source of truth)

Do **not** re-document the host protocol or the SDK surface inline - a
hand-copied cheat-sheet drifts. The canonical, always-current references
are auto-synced from `pollen-robotics/reachy_mini` at build time into
`daemon/`. Load either via `read_skill_doc` when you need exact detail:

- **Host / embed protocol v1** - the `embed:ready` / `host:init` /
  `#creds=<base64(CredsBundle)>` handshake, the `CredsBundle` shape, and
  the `mountHost` / `connectToHost` entrypoints: read
  [daemon/APP_CREATION_GUIDE.md](daemon/APP_CREATION_GUIDE.md) (§11.5 and
  §13). You never implement this by hand - the SDK host entries do it; the
  template just calls `mountHost()` / `connectToHost()`.
- **JS SDK method/event reference** - the exact current names for
  `setHeadRpyDeg`, `setAntennasDeg`, `setBodyYawDeg`, `attachVideo`,
  `playSound`, `sendRaw`, the lifecycle, and every event: read
  [daemon/javascript-sdk.md](daemon/javascript-sdk.md).

## What to tell the user after creating these files

1. Click **Publish to HF Space** in the top bar.
2. Once deployed, the same Space runs in three places:
   - **Standalone**: open the Space URL directly. HF auto-provisions
     the OAuth app from `hf_oauth: true`; the page shows "Sign in
     with Hugging Face".
   - **Host shell**: open
     `https://tfrere-reachy-mini-host.hf.space/?app=<your-username>/<your-space>`.
     The host signs the user in once and reuses that session across
     every compatible app.
   - **Reachy Mini mobile app**: the Space appears in the apps list
     (no extra wiring required - the bootstrap script picks up
     `?embedded=1#creds=<base64>` and the `embed:ready`/`host:init`
     handshake automatically).
3. Sign in → Connect → pick the robot → interact.
