---
title: Reachy Mini Vibe Coding Apps
emoji: 🤖
colorFrom: indigo
colorTo: pink
sdk: docker
app_port: 7860
pinned: false
hf_oauth: true
hf_oauth_scopes:
  - write-repos
  - manage-repos
short_description: Vibe-code tiny static Reachy Mini apps.
tags:
  - reachy_mini
  - agent
  - vibe-coding
---

# Reachy Mini · Vibe Coding Apps

A conversational agent that helps you vibe-code **tiny static browser
apps** for Reachy Mini robots, then publishes them as Hugging Face
Spaces in one click.

The agent is intentionally constrained to one artifact type: a
**3-file static Space** (`index.html`, `main.js`, `README.md`) with
no build step, no npm, no Docker, and no server-side secrets other
than HF OAuth (auto-injected by the platform). This keeps the
iterate -> preview -> publish loop tight: everything the agent writes
is directly runnable in the sandboxed preview iframe, and whatever
previews green also ships green to HF Spaces.

The agent is grounded in the `reachy-mini-app` skill, which ships the
reference template plus concept-level robot knowledge (DOF, safety
limits, `goto` vs `setTarget`, antennas-as-buttons, daemon
REST/WebSocket surface). Ask for an app, the agent produces the three
files, lets you preview them live in a sandboxed iframe, and publishes
the result to a new HF Space under your account.

Generated apps are zero-config compatible with the wider Reachy Mini
ecosystem: the same 3 files run **standalone**, inside the sandboxed
preview iframe of this vibe coder, and **embedded in any Reachy Mini
host** (the mobile app or a host shell) mounted at
`?embedded=1#creds=<base64>` and driven by the current protocol-v1
handshake (`embed:ready` → `host:init`, messages tagged
`source: "reachy-mini"`, `version: 1`). All three contexts share one
inline bootstrap script at the top of `<head>` - the agent inserts it
verbatim from the skill template.

## Architecture

```
frontend/                    Vite + React + @ai-sdk/react
  src/
    components/
      TopBar.tsx             HF user avatar, model picker, Publish button
      ChatPanel.tsx          Agent conversation
      CodeEditor.tsx         Monaco, one tab per virtual-FS file
      PreviewFrame.tsx       Sandboxed iframe running the generated app
    hooks/
      useAgentChat.ts        useChat + client-side tool execution
      useVirtualFS.ts        In-memory file tree
      useHfAuth.ts           HF OAuth (hfSpacesOauthLogin)

backend/                     Hono + Vercel AI SDK (ai + openrouter)
  src/
    server.ts                Hono app, mounts /api + serves static frontend
    auth.ts                  Verifies HF access tokens on /api/*
    agent/
      chat.ts                streamText() with editor tools + skill tools
      tools.ts               writeFile, editFile, deleteFile, readFile, readSkillDoc
      system-prompt.ts       Base prompt + injected SKILL.md
      skill-loader.ts        Reads skills/ at runtime
      skills/
        reachy-mini-app/
          SKILL.md               Hub (always injected in the system prompt)
                                 - hard constraints (static, 3 files, no build)
                                 - full reference template for index.html + main.js + README.md
          robot-overview.md      Robot knowledge - DOF, safety, motors
          robot-motion.md        Robot knowledge - goto vs setTarget
          robot-interaction.md   Robot knowledge - antennas, head-as-joystick
          robot-rest-api.md      Robot knowledge - daemon HTTP + WS API
    routes/
      publish.ts             @huggingface/hub createRepo + uploadFiles

docker-entrypoint.d/
  10-inject-hf-vars.sh       envsubst OAUTH_CLIENT_ID / SPACE_* into dist/index.html
```

## Local development

### Prerequisites

- Node.js 20+
- An [OpenRouter API key](https://openrouter.ai/keys) (backend)
- A Hugging Face OAuth app for local dev (see below)

### HF OAuth for localhost

On a Space the OAuth client ID is injected automatically. For local dev:

1. Register an OAuth app at <https://huggingface.co/settings/applications/new>
2. Fill in:
   - **Homepage URL**: `http://localhost:5173`
   - **Scopes**: `openid`, `profile`, `write-repos`, `manage-repos`
   - **Redirect URIs**: `http://localhost:5173`
3. Copy the client ID into `frontend/.env.local`:
   ```
   VITE_HF_OAUTH_CLIENT_ID=xxxx-xxxx-xxxx
   ```

### Run

```bash
# Terminal 1 - backend
cd backend
cp .env.example .env  # fill OPENROUTER_API_KEY
npm install
npm run dev

# Terminal 2 - frontend
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173>.

## Deploy to HF Spaces

Push this repo to a Space with `sdk: docker`. The `docker-entrypoint.d`
script injects the OAuth credentials from the Space runtime into the built
`index.html` at container start.

```bash
git remote add space https://huggingface.co/spaces/<your-username>/reachy-mini-vibe-coder
git push space main
```

## Environment variables (Space secrets)

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | yes | Powers the agent |
| `OPENROUTER_MODEL`   | no  | Default `anthropic/claude-sonnet-4-5` |

## License

MIT. The embedded skill files are derived from the `reachy-mini-project-folder`
internal docs; the underlying SDKs keep their own licenses.
