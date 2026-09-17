import { Hono } from "hono";
import { stream } from "hono/streaming";
import { createRepo, uploadFiles, spaceInfo } from "@huggingface/hub";
import { getHfToken, getHfUser } from "../auth.js";
import { REACHY_DEFAULT_ICON_SVG } from "../assets/default-app-icon.js";

export const publishRoute = new Hono();

interface VirtualFile {
  path: string;
  content: string;
}

/**
 * Ensure every published app ships an `icon.svg` at the repo root - the
 * conventional path the host probes for the app's top-bar / catalog / favicon
 * glyph (`${embedUrl}/icon.svg`, see host TopBar). If the app already provides
 * its own `icon.svg` we leave it untouched; otherwise we inject the default
 * "reachy simple" model icon (the same glyph the host picker shows for each
 * robot). Returns a NEW array; never mutates the input.
 */
export function withDefaultIcon(
  files: VirtualFile[],
  iconSvg: string = REACHY_DEFAULT_ICON_SVG,
): VirtualFile[] {
  const hasIcon = files.some(
    (f) => f.path.replace(/^\.?\/+/, "").toLowerCase() === "icon.svg",
  );
  if (hasIcon) return files.slice();
  return [...files, { path: "icon.svg", content: iconSvg }];
}

interface PublishBody {
  repoName?: string; // "my-app" - username is inferred from token
  private?: boolean;
  files: VirtualFile[];
  overwrite?: boolean;
  commitMessage?: string;
}

/**
 * Normalize a user-provided repo slug. HF space names allow `[A-Za-z0-9-_.]`.
 */
function sanitizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function textToBlob(content: string): Blob {
  return new Blob([content], { type: "text/plain; charset=utf-8" });
}

/**
 * Parse the YAML frontmatter of the virtual README.md to figure out which
 * HF Space SDK to create the repo with. We only look at the `sdk:` line.
 * Falls back to "docker" so existing voice-app flows keep working.
 *
 * Tolerant of a leading BOM / blank lines before the `---` fence: without this
 * a README that doesn't start byte-0 with `---` would silently fall back to
 * `docker`, create a DOCKER Space, and then the commit of a `sdk: static`
 * README would be rejected (you can't switch a Space's sdk via a commit) - a
 * "create OK, commit 400" failure.
 */
export function inferSpaceSdk(files: VirtualFile[]): "docker" | "static" {
  const readme = files.find((f) => f.path.toLowerCase() === "readme.md");
  if (!readme) return "docker";
  const normalized = readme.content.replace(/^\uFEFF/, "").replace(/^\s+/, "");
  const fmMatch = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return "docker";
  const sdkLine = fmMatch[1].match(/^\s*sdk\s*:\s*(\S+)/m);
  if (!sdkLine) return "docker";
  const sdk = sdkLine[1].trim().toLowerCase().replace(/['"]/g, "");
  return sdk === "static" ? "static" : "docker";
}

/**
 * Extract the REAL failure reason from a thrown error. `@huggingface/hub`'s
 * `HubApiError` carries the parsed HF response body on `.data` (the actual
 * reason: card validation, bad request, revision not found, …) plus
 * `.statusCode` / `.requestId`, but its `.message` collapses to a generic
 * "Api error with status 400" whenever the body has no top-level
 * `error`/`message` key (which the NDJSON `/commit` endpoint often omits). We
 * surface `.data` so both the server log and the UI show the truth instead of
 * an opaque 400.
 */
export function describeHubError(error: unknown): {
  message: string;
  statusCode?: number;
  requestId?: string;
  detail?: unknown;
} {
  if (error && typeof error === "object") {
    const e = error as {
      message?: string;
      statusCode?: number;
      requestId?: string;
      data?: unknown;
    };
    let bodyMsg: string | undefined;
    if (e.data && typeof e.data === "object") {
      const d = e.data as Record<string, unknown>;
      bodyMsg =
        (typeof d.error === "string" ? d.error : undefined) ??
        (typeof d.message === "string" ? d.message : undefined) ??
        safeStringify(d);
    } else if (typeof e.data === "string" && e.data.trim()) {
      bodyMsg = e.data.trim();
    }
    const base = e.message || "Publish failed";
    const message =
      bodyMsg && !base.includes(bodyMsg) ? `${base} — ${bodyMsg}` : base;
    return {
      message,
      statusCode: e.statusCode,
      requestId: e.requestId,
      detail: e.data,
    };
  }
  return {
    message: error instanceof Error ? error.message : "Unknown error",
  };
}

function safeStringify(value: unknown): string | undefined {
  try {
    const s = JSON.stringify(value);
    return s && s !== "{}" ? s.slice(0, 2000) : undefined;
  } catch {
    return undefined;
  }
}

publishRoute.post("/", async (c) => {
  const token = getHfToken(c);
  const user = getHfUser(c);
  if (!token || !user) {
    return c.json(
      { error: "A valid Hugging Face access token is required to publish." },
      401,
    );
  }

  let body: PublishBody;
  try {
    body = (await c.req.json()) as PublishBody;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0) {
    return c.json({ error: "No files provided" }, 400);
  }

  const slug = sanitizeSlug(body.repoName ?? `reachy-app-${Date.now()}`);
  if (!slug) {
    return c.json({ error: "Invalid repo name" }, 400);
  }

  const repoId = `${user.name}/${slug}`;
  const repo = { type: "space" as const, name: repoId };

  // Server-Sent Events for progress
  c.header("Content-Type", "text/event-stream; charset=utf-8");
  c.header("Cache-Control", "no-cache, no-store");
  c.header("X-Accel-Buffering", "no");

  return stream(c, async (s) => {
    const send = (event: string, data: Record<string, unknown>) =>
      s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      await send("progress", { step: "check", message: `Checking ${repoId}…` });

      let alreadyExists = false;
      try {
        await spaceInfo({ name: repoId, accessToken: token });
        alreadyExists = true;
      } catch {
        alreadyExists = false;
      }

      if (alreadyExists && !body.overwrite) {
        await send("error", {
          step: "check",
          message: `Space "${repoId}" already exists. Set overwrite=true to update it.`,
          code: "REPO_EXISTS",
          repoId,
        });
        return;
      }

      const sdk = inferSpaceSdk(files);
      // Auto-attach the default "reachy simple" icon.svg when the app didn't
      // ship its own, so the published Space always has a Reachy-branded glyph.
      const filesToPublish = withDefaultIcon(files);
      const uploads = filesToPublish.map((f) => ({
        path: f.path,
        content: textToBlob(f.content),
      }));
      const nFiles = `${filesToPublish.length} file${filesToPublish.length === 1 ? "" : "s"}`;

      if (!alreadyExists) {
        await send("progress", {
          step: "create",
          message: `Creating ${sdk} Space ${repoId} with ${nFiles}…`,
        });
        // Create the Space AND commit the files in ONE atomic request. This
        // replaces the old two-step "createRepo() then uploadFiles()" flow,
        // whose separate POST /commit/main right after creation was returning
        // 400 (files never landed). Creating with the initial `files` lets the
        // create endpoint carry the commit + validate the card in one shot,
        // sidestepping a fresh-branch / parentCommit race.
        await createRepo({
          repo,
          accessToken: token,
          private: body.private ?? false,
          sdk,
          files: uploads,
        });
      } else {
        await send("progress", {
          step: "upload",
          message: `Updating existing Space ${repoId} (${nFiles})…`,
        });
        await uploadFiles({
          repo,
          accessToken: token,
          files: uploads,
          commitTitle:
            body.commitMessage ?? "Update from Reachy Mini Vibe Coding Apps",
        });
      }

      const spaceUrl = `https://huggingface.co/spaces/${repoId}`;
      await send("done", {
        step: "done",
        repoId,
        spaceUrl,
        message: `Published to ${spaceUrl}`,
      });
    } catch (error) {
      // Surface the REAL HF reason (body) - not just the opaque
      // "Api error with status 400" - to both the server log and the UI.
      const info = describeHubError(error);
      console.error("[publish] error:", {
        repoId,
        message: info.message,
        statusCode: info.statusCode,
        requestId: info.requestId,
        body: info.detail,
      });
      await send("error", {
        step: "error",
        message: info.message,
        statusCode: info.statusCode,
        requestId: info.requestId,
        detail: info.detail,
      });
    }
  });
});
