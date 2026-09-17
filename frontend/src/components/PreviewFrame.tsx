import { useEffect, useMemo, useRef, useState } from "react";
import type { VirtualFile } from "../hooks/useVirtualFS";
import { compileScript, isCompilable } from "../lib/bundler";
import type { Diagnostic } from "../hooks/usePreviewDiagnostics";
import { buildPreviewAuthScript } from "../lib/preview-auth";
import { svgToDataUrl } from "../lib/sticker";

interface PreviewFrameProps {
  files: VirtualFile[];
  version: number;
  /**
   * Hugging Face access token from the parent app. When set, the preview
   * seeds it into the SDK's sessionStorage keys so a generated app's
   * `mountHost()` / `connectToHost()` authenticates from cache and skips
   * the OAuth round-trip (which can't complete in a srcDoc iframe). This is
   * what lets the preview render the REAL host shell (top bar + picker)
   * even without a live robot. See `lib/preview-auth.ts`.
   */
  accessToken?: string | null;
  /** HF username, seeded alongside the token so the host top bar shows it. */
  userName?: string | null;
  /**
   * Called with the latest `docId` as soon as a new preview HTML document
   * is prepared. The parent uses this to discard stale postMessage
   * diagnostics from an older iframe that may still be flushing after a
   * re-render.
   */
  onDocReady?: (docId: number) => void;
  /**
   * Called with compile errors produced by esbuild-wasm BEFORE the iframe
   * starts running. Runtime errors come through the `postMessage` channel
   * instead and are collected by the parent's diagnostics hook.
   */
  onCompileError?: (diagnostic: Diagnostic) => void;
}

/**
 * Render the virtual FS inside a sandboxed iframe.
 *
 * Pipeline:
 * 1. Take `index.html` from the virtual FS.
 * 2. For each local `<script src=...>`, inline the target file. Compile
 *    `.ts`/`.tsx`/`.jsx` through esbuild-wasm before injection.
 * 3. Inline local CSS via `<style>` tags.
 * 4. Inject an error reporter at the top of `<head>` that forwards
 *    runtime errors to the parent via `postMessage`.
 * 5. Inject the parent's HF token (`__REACHY_MINI_PREVIEW_TOKEN__`) so
 *    the app can bypass OAuth, which would otherwise fail in a srcDoc
 *    iframe (redirect URI would be `about:srcdoc`).
 */
export async function buildPreviewDoc(
  files: VirtualFile[],
  accessToken: string | null | undefined,
  docId: number,
  onCompileError?: (d: Diagnostic) => void,
  userName?: string | null,
): Promise<string | null> {
  const fileMap = new Map(files.map((f) => [f.path, f.content]));

  const rawHtml = fileMap.get("index.html");
  if (!rawHtml) return null;

  const assetRegex =
    /<(?:link|script)[^>]*\b(href|src)\s*=\s*(["'])([^"']+)\2[^>]*>(?:\s*<\/script>)?/gi;

  const matches: Array<{
    match: string;
    attr: string;
    rawPath: string;
    index: number;
  }> = [];
  for (const m of rawHtml.matchAll(assetRegex)) {
    matches.push({
      match: m[0],
      attr: m[1],
      rawPath: m[3],
      index: m.index ?? 0,
    });
  }

  const replacements = new Map<string, string>();
  await Promise.all(
    matches.map(async ({ match, attr, rawPath }) => {
      if (/^(?:https?:)?\/\//i.test(rawPath) || rawPath.startsWith("data:")) {
        return;
      }
      const normalized = rawPath.replace(/^\.?\/+/, "");
      const content = fileMap.get(normalized);
      const isHref = attr.toLowerCase() === "href";

      // A missing local asset must never fall through to a network fetch:
      // depending on the iframe base it would either 404 or (historically,
      // under srcdoc + allow-same-origin) fetch the vibe-coder SPA's
      // index.html and get parsed as JS/CSS - spamming `Unexpected token
      // '<'`. We pre-empt that by neutralising the tag and surfacing one
      // structured compile-error instead.
      if (content === undefined) {
        const kind = isHref
          ? normalized.endsWith(".css")
            ? "stylesheet"
            : "href asset"
          : "script";
        const msg = `Missing ${kind} in virtual FS: ${rawPath}`;
        onCompileError?.({
          docId,
          kind: "compile-error",
          message: msg,
          file: rawPath,
          line: 1,
          col: 1,
          timestamp: Date.now(),
        });
        // Replace with an inert stub - we already surfaced the error via
        // onCompileError above; emitting a console.error from the stub
        // would double-report through the iframe's postMessage channel.
        replacements.set(
          match,
          `<!-- [preview] missing ${kind}: ${rawPath} -->`,
        );
        return;
      }

      if (isHref && normalized.endsWith(".css")) {
        replacements.set(
          match,
          `<style data-inlined="${normalized}">\n${content}\n</style>`,
        );
        return;
      }

      if (attr.toLowerCase() !== "src") return;

      if (isCompilable(normalized)) {
        const result = await compileScript(normalized, content);
        if (result.ok) {
          replacements.set(
            match,
            `<script type="module" data-inlined="${normalized}">\n${result.code}\n</script>`,
          );
        } else {
          const { file, line, column, text } = result.error;
          onCompileError?.({
            docId,
            kind: "compile-error",
            message: text,
            file,
            line,
            col: column,
            timestamp: Date.now(),
          });
          const escaped = JSON.stringify(
            `[${file}:${line}:${column}] ${text}`,
          );
          replacements.set(
            match,
            `<script>throw new SyntaxError(${escaped});</script>`,
          );
        }
        return;
      }

      if (normalized.endsWith(".js") || normalized.endsWith(".mjs")) {
        replacements.set(
          match,
          `<script type="module" data-inlined="${normalized}">\n${content}\n</script>`,
        );
      }
    }),
  );

  const inlined = rawHtml.replace(assetRegex, (m) => replacements.get(m) ?? m);

  // Seed the HF session into the SDK's storage keys so the generated app
  // authenticates from cache and renders the real host shell in preview.
  const tokenScript = buildPreviewAuthScript(accessToken, userName);

  const reporterScript = `<script>
(() => {
  var DOC_ID = ${JSON.stringify(docId)};
  var send = function(payload){
    try { parent.postMessage(Object.assign({ source: "reachy-preview", docId: DOC_ID }, payload), "*"); } catch(_e){}
  };
  // Nested-embed relay: in host preview the app actually RUNS inside a second
  // (embed) blob iframe that mountHost creates as our child. Its reporter posts
  // diagnostics to ITS parent (us), not to the vibe-coder. Forward those up one
  // level so auto-fix still sees the app's real runtime errors. We only relay
  // messages coming from a child window (not our own parent), and only when we
  // actually have a parent, so there's no echo loop.
  try {
    addEventListener("message", function(e){
      var d = e && e.data;
      if (!d || d.source !== "reachy-preview") return;
      if (parent === window) return;
      if (e.source === parent) return; // never bounce a parent message back up
      try { parent.postMessage(d, "*"); } catch(_e){}
    });
  } catch(_e){}
  // Classify WHERE a diagnostic came from, structurally (not by message
  // text). The parent uses this instead of the fragile allow-list:
  //   sdk-cdn  -> code loaded from a public CDN (SDK / deps) = environmental
  //   own-code -> the app's own inlined files (blob:/about:srcdoc doc)
  //   unknown  -> can't tell; the parent falls back to its legacy allow-list
  var classifyOrigin = function(hay){
    hay = String(hay || "");
    if (/(cdn\\.jsdelivr\\.net|esm\\.sh|unpkg\\.com|cdn\\.skypack\\.dev)/i.test(hay)) return "sdk-cdn";
    // The preview app runs from a same-origin blob: URL (or about:srcdoc). Its
    // own errors carry a "blob:https://…"/"about:…" filename+stack whose
    // "https://" would otherwise be misread as a remote origin. Strip the WHOLE
    // blob/about token so an app-code error (e.g. a TDZ "Cannot access 'x'
    // before initialization") is correctly own-code (actionable), not unknown.
    var remote = hay.replace(/blob:https?:\\/\\/[^\\s'"]*/gi, "").replace(/about:[^\\s'"]*/gi, "");
    if (/https?:\\/\\//i.test(remote)) return "unknown";
    return "own-code";
  };
  var fmt = function(args){
    return Array.prototype.slice.call(args).map(function(a){
      if (a instanceof Error) return (a.message || "") + (a.stack ? "\\n" + a.stack : "");
      if (typeof a === "object") { try { return JSON.stringify(a); } catch(_e){ return String(a); } }
      return String(a);
    }).join(" ");
  };
  // "booted": the app's inline module executed far enough to schedule a
  // microtask without an uncaught synchronous error. Lets the parent treat
  // "loaded + only non-actionable diagnostics" as success.
  Promise.resolve().then(function(){ send({ kind: "booted" }); });
  send({ kind: "ready" });
  addEventListener("error", function(e){
    var stack = e.error && e.error.stack;
    send({
      kind: "error",
      severity: "error",
      origin: classifyOrigin((e.filename || "") + " " + (stack || "")),
      message: e.message || String(e.error || ""),
      stack: stack,
      file: e.filename,
      line: e.lineno,
      col: e.colno,
    });
  });
  addEventListener("unhandledrejection", function(e){
    var reason = e.reason;
    var stack = reason && reason.stack;
    var msg = (reason && (reason.message || String(reason))) || "unhandled rejection";
    send({
      kind: "unhandledrejection",
      severity: "error",
      origin: classifyOrigin(msg + " " + (stack || "")),
      message: msg,
      stack: stack,
    });
  });
  var origErr = console.error.bind(console);
  console.error = function(){
    try {
      var m = fmt(arguments);
      send({ kind: "console.error", severity: "error", origin: classifyOrigin(m), message: m });
    } catch(_e){}
    origErr.apply(null, arguments);
  };
  var origWarn = console.warn.bind(console);
  console.warn = function(){
    // Captured for visibility but tagged as a non-actionable log: warn is
    // the template's explicit "expected / environmental" channel, so a
    // warn NEVER triggers the auto-fix loop (severity "log").
    try {
      var m = fmt(arguments);
      send({ kind: "console.warn", severity: "log", origin: classifyOrigin(m), message: m });
    } catch(_e){}
    origWarn.apply(null, arguments);
  };
})();
</script>`;

  // Reflect the REAL app icon in preview: if the VFS carries an `icon.svg`
  // (agent-generated or user-provided), expose it as a data URL global the
  // template reads for `mountHost({ appIconUrl })`. Without this the host top
  // bar would fetch `<origin>/icon.svg` (the static default) and never show
  // the generated one. Only emitted when an icon.svg actually exists, so it
  // stays undefined otherwise and the app falls back to the default.
  const iconContent = fileMap.get("icon.svg") ?? fileMap.get("./icon.svg");
  const iconScript =
    iconContent && /<svg[\s>]/i.test(iconContent)
      ? `<script>window.__REACHY_MINI_ICON_URL__=${JSON.stringify(
          svgToDataUrl(iconContent),
        )};</script>`
      : "";

  const headInjections = `${reporterScript}${tokenScript ? "\n" + tokenScript : ""}${iconScript ? "\n" + iconScript : ""}`;

  const withInjections = /<head[^>]*>/i.test(inlined)
    ? inlined.replace(/<head[^>]*>/i, (m) => `${m}\n${headInjections}`)
    : `${headInjections}\n${inlined}`;

  const bannerDoc = `<!-- Preview generated by reachy-mini-vibe-coder (docId=${docId}) -->`;
  return `${bannerDoc}\n${withInjections}`;
}

/**
 * Wrap the base preview doc (which runs the generated app) into the STANDALONE
 * doc that the preview actually loads, enabling a LIVE host session in preview.
 *
 * Why: the app's standalone path calls `mountHost()`, and when the user picks
 * their (real, listed) robot the host embeds an iframe at
 * `new URL(embedPath, window.location.origin)` (ReachyHostShell.tsx). The
 * default `embedPath` is `/?embedded=1` - but this Space is `sdk: static`, so
 * that URL serves the vibe-coder SPA, NOT the generated app: the embed
 * handshake never happens and the host hangs on the "link" step forever.
 *
 * Fix: inject, BEFORE the app module runs, a bootstrap that turns the SAME base
 * doc into a same-origin `blob:` URL and exposes it as
 * `window.__REACHY_MINI_EMBED_URL__`. The generated app passes that as
 * `mountHost({ embedPath })`, so the host embeds the ACTUAL app. Because the
 * blob is created INSIDE this document, a child iframe can load it; because it
 * inherits the parent (Space) origin, it satisfies the host bridge's
 * same-origin check (useHostBridge.ts) and the SDK's `#creds=` fragment
 * survives, so the full protocol-v1 handshake (embed:ready/host:init) runs and
 * the app connects to the listed robot over HF central signaling. Verified end
 * to end in tests/e2e/host-embed-handshake.spec.ts.
 *
 * The embedded doc is the base doc WITHOUT this bootstrap, so there is no
 * infinite nesting.
 *
 * `baseOrigin` (optional): when given, a `<base href="<origin>/">` is injected
 * so relative URLs in the host shell resolve to the Space origin instead of the
 * `blob:` document. This is what lets the host top bar's `<img src="icon.svg">`
 * load the default icon we serve at `<origin>/icon.svg` in preview - a blob
 * document has no fetchable relative base, so without it the icon never loads.
 */
export function wrapStandaloneWithEmbed(
  baseDoc: string,
  baseOrigin?: string,
): string {
  const embedLiteral = JSON.stringify(baseDoc)
    // `</script>` inside the literal would prematurely close the bootstrap
    // <script>; escape the closing tag (runtime-equivalent).
    .replace(/<\/(script)/gi, "<\\/$1")
    // U+2028/U+2029 are valid JSON but can terminate a JS string literal on
    // older engines; escape defensively.
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const baseTag = baseOrigin
    ? `<base href="${baseOrigin.replace(/"/g, "&quot;").replace(/\/+$/, "")}/">`
    : "";
  const bootstrap = `<script>(function(){try{
  window.__REACHY_MINI_EMBED_URL__ = URL.createObjectURL(new Blob([${embedLiteral}], { type: "text/html" }));
}catch(_e){}})();</script>`;
  // `<base>` must come first in <head> so it governs every relative URL.
  const headInjection = `${baseTag}${baseTag ? "\n" : ""}${bootstrap}`;
  return /<head[^>]*>/i.test(baseDoc)
    ? baseDoc.replace(/<head[^>]*>/i, (m) => `${m}\n${headInjection}`)
    : `${headInjection}\n${baseDoc}`;
}

export function PreviewFrame({
  files,
  version,
  accessToken,
  userName,
  onDocReady,
  onCompileError,
}: PreviewFrameProps) {
  const [docHtml, setDocHtml] = useState<string | null>(null);
  const [docId, setDocId] = useState<number>(0);
  // The preview is loaded from a same-origin `blob:` URL rather than
  // `srcdoc`. Reason: an `about:srcdoc` document has an OPAQUE origin, so
  // `window.location.origin` serialises to the string "null". The Reachy
  // host shell computes the embed iframe URL with
  // `new URL(embedPath, window.location.origin)` (ReachyHostShell.tsx),
  // which throws `Failed to construct 'URL': Invalid base URL` on a "null"
  // base the moment a robot is picked -> the whole preview goes black. A
  // blob URL created here inherits the PARENT's real origin (with
  // `allow-same-origin` in the sandbox), so `location.origin` is a valid
  // absolute origin and that `new URL(...)` resolves cleanly.
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const buildSeqRef = useRef<number>(0);

  const hasIndex = useMemo(
    () => files.some((f) => f.path === "index.html"),
    [files],
  );

  useEffect(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(async () => {
      const seq = ++buildSeqRef.current;
      const nextDocId = Date.now();
      const base = await buildPreviewDoc(
        files,
        accessToken,
        nextDocId,
        onCompileError,
        userName,
      );
      if (seq !== buildSeqRef.current) return; // stale build superseded
      // Wrap the base doc so the standalone `mountHost()` path can embed the
      // REAL app (same-origin blob) and run a live session in preview. The
      // Space origin is injected as `<base href>` so the host top bar's
      // relative `icon.svg` loads the default icon we serve at `/icon.svg`.
      const doc =
        base === null
          ? null
          : wrapStandaloneWithEmbed(base, window.location.origin);
      setDocId(nextDocId);
      setDocHtml(doc);
      if (doc !== null) onDocReady?.(nextDocId);
    }, 300);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [files, version, accessToken, userName, onDocReady, onCompileError]);

  // Turn the built document into a same-origin blob URL and revoke the
  // previous one so we don't leak object URLs across rebuilds.
  useEffect(() => {
    if (docHtml === null) {
      setBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([docHtml], { type: "text/html" }),
    );
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [docHtml]);

  if (!hasIndex) {
    return (
      <div className="preview-empty">
        <p>No <code>index.html</code> in the virtual FS yet.</p>
        <p style={{ marginTop: 8 }}>Ask the agent to create one.</p>
      </div>
    );
  }

  if (docHtml === null || blobUrl === null) {
    return <div className="preview-empty">Building preview…</div>;
  }

  return (
    <iframe
      key={docId}
      className="preview-frame"
      title="App preview"
      // Same-origin blob URL (see `blobUrl` above): gives the preview a
      // valid `location.origin` so the host shell's `new URL(embedPath,
      // origin)` does not crash. `allow-same-origin` is REQUIRED for the
      // blob to inherit the parent origin (and for the reporter/token seed).
      src={blobUrl}
      sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
    />
  );
}
