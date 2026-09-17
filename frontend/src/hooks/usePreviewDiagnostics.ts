import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type DiagnosticKind =
  | "error"
  | "unhandledrejection"
  | "console.error"
  | "console.warn"
  | "compile-error"
  | "ready"
  | "booted";

/** Structured severity, set by the reporter. `log` = never actionable. */
export type DiagnosticSeverity = "error" | "log";

/**
 * Structured origin, set by the reporter from the error's file/stack:
 *   own-code -> the app's own inlined files (actionable if it's an error)
 *   sdk-cdn  -> code from a public CDN (SDK / deps) = environmental noise
 *   unknown  -> undecidable; the predicate falls back to the legacy regex
 */
export type DiagnosticOrigin = "own-code" | "sdk-cdn" | "unknown";

export interface Diagnostic {
  docId: number;
  kind: DiagnosticKind;
  message: string;
  stack?: string;
  file?: string;
  line?: number;
  col?: number;
  timestamp: number;
  severity?: DiagnosticSeverity;
  origin?: DiagnosticOrigin;
  /**
   * How many times this exact diagnostic was reported consecutively
   * (same fingerprint as the previous entry). 1 means "first occurrence".
   */
  count?: number;
}

interface PreviewPostMessage {
  source?: string;
  docId?: number;
  kind?: DiagnosticKind;
  message?: string;
  stack?: string;
  file?: string;
  line?: number;
  col?: number;
  severity?: DiagnosticSeverity;
  origin?: DiagnosticOrigin;
}

/**
 * LEGACY fallback only. Primary classification is now structural (by
 * `severity` + `origin`, set by the reporter). This regex list is consulted
 * ONLY when origin is "unknown" - it catches environmental noise the
 * structural check couldn't attribute. Still displayed in the panel, never
 * actionable when matched.
 */
const ALLOW_LIST: RegExp[] = [
  /no robot/i,
  /robot[_ ]?busy/i,
  /not authenticated/i,
  /\b(401|403)\b/,
  /websocket.*(fail|clos|error)/i,
  /webrtc.*(fail|disconnect|closed)/i,
  /ice.*fail/i,
  /signaling.*(fail|closed)/i,
  /cdn\.jsdelivr\.net/i,
  /reachy-mini\.js/i,
  // Preview-only environment noise: the sandboxed preview has no robot
  // online, so the generated app's own connect/session warnings are not
  // actionable code bugs. Match the app template's messages + tag.
  /come online/i,
  /preview connect/i,
  /embedded connect/i,
  /failed to start session/i,
  /\[reachy-mini\]/i,
];

const DEDUPE_WINDOW_MS = 8000;
const MAX_ENTRIES = 50;

function fingerprint(d: Diagnostic): string {
  return `${d.kind}::${d.message}::${d.file ?? ""}::${d.line ?? ""}`;
}

/**
 * Decide whether a diagnostic should drive an auto-fix attempt.
 *
 * Structural classification first (the source of truth), regex only as a
 * last-resort fallback for undecidable origins:
 *   - lifecycle signals (ready/booted) -> never actionable
 *   - severity "log" (console.warn) -> never actionable (the template's
 *     explicit "expected/environmental" channel)
 *   - compile-error -> always actionable (it's the app's own code)
 *   - error/rejection/console.error:
 *       origin sdk-cdn  -> not actionable (environmental, not the app's bug)
 *       origin own-code  -> actionable
 *       origin unknown   -> fall back to the legacy ALLOW_LIST regex
 */
/**
 * A "missing local asset" compile-error - the build-race artifact emitted
 * when `index.html` references a local file that isn't in the VFS yet
 * (e.g. `./main.js` before the agent has written it). These become stale
 * once a newer build resolves the reference.
 */
export function isMissingAssetError(d: Diagnostic): boolean {
  return (
    d.kind === "compile-error" && /missing .*in virtual fs/i.test(d.message)
  );
}

export function isActionable(d: Diagnostic): boolean {
  if (d.kind === "ready" || d.kind === "booted") return false;
  if (d.severity === "log" || d.kind === "console.warn") return false;
  if (d.kind === "compile-error") return true;
  if (d.origin === "sdk-cdn") return false;
  if (d.origin === "own-code") return true;
  // origin unknown (or missing): legacy text-based allow-list.
  const haystack = `${d.message}\n${d.stack ?? ""}`;
  return !ALLOW_LIST.some((re) => re.test(haystack));
}

/**
 * Collects runtime + compile diagnostics from the preview iframe.
 *
 * The hook is agnostic of the source: `push()` accepts any shape and
 * `pushFromIframe(event)` takes a raw `MessageEvent` and filters/parses
 * it. Stale messages (from a previous iframe still unwinding) are dropped
 * by comparing `docId` against the one the parent last acknowledged via
 * `setDocId`.
 *
 * `actionable` is what the auto-fix loop reads: the subset of recent
 * entries that are NOT in the allow-list.
 */
export function usePreviewDiagnostics() {
  const [entries, setEntries] = useState<Diagnostic[]>([]);
  // True once the current preview document has signalled it executed its
  // inline module without a synchronous uncaught error. The auto-fix loop
  // uses this to treat "loaded + only non-actionable diagnostics" as a
  // success instead of retrying.
  const [booted, setBooted] = useState(false);
  // The current preview document id, mirrored as state so `actionable`
  // recomputes when a newer build supersedes older diagnostics.
  const [currentDocId, setCurrentDocId] = useState(0);
  const currentDocIdRef = useRef<number>(0);
  const recentSeenRef = useRef<Map<string, number>>(new Map());

  const push = useCallback((raw: Diagnostic) => {
    const current = currentDocIdRef.current;
    if (current && raw.docId && raw.docId < current) return;

    const fp = fingerprint(raw);
    const now = raw.timestamp || Date.now();
    const last = recentSeenRef.current.get(fp);
    if (last && now - last < DEDUPE_WINDOW_MS) return;
    recentSeenRef.current.set(fp, now);

    setEntries((prev) => {
      // If the head row has the same fingerprint, collapse in place
      // (increment count + refresh timestamp) instead of prepending a
      // duplicate. Makes the panel behave like Chrome DevTools does.
      const head = prev[0];
      if (head && fingerprint(head) === fp) {
        const updated: Diagnostic = {
          ...head,
          timestamp: now,
          count: (head.count ?? 1) + 1,
        };
        return [updated, ...prev.slice(1)];
      }
      const entry: Diagnostic = { ...raw, count: raw.count ?? 1 };
      const next = [entry, ...prev];
      return next.slice(0, MAX_ENTRIES);
    });
  }, []);

  const pushFromIframe = useCallback(
    (event: MessageEvent) => {
      const data = event.data as PreviewPostMessage | undefined;
      if (!data || data.source !== "reachy-preview") return;
      if (!data.kind) return;
      if (data.kind === "ready") {
        if (typeof data.docId === "number") {
          currentDocIdRef.current = Math.max(
            currentDocIdRef.current,
            data.docId,
          );
        }
        return;
      }
      if (data.kind === "booted") {
        // Only trust a boot signal from the current (or newer) document.
        if (
          typeof data.docId !== "number" ||
          data.docId >= currentDocIdRef.current
        ) {
          setBooted(true);
        }
        return;
      }
      const d: Diagnostic = {
        docId: data.docId ?? currentDocIdRef.current,
        kind: data.kind,
        message: data.message ?? "",
        stack: data.stack,
        file: data.file,
        line: data.line,
        col: data.col,
        severity: data.severity,
        origin: data.origin,
        timestamp: Date.now(),
      };
      push(d);
    },
    [push],
  );

  const setDocId = useCallback((id: number) => {
    currentDocIdRef.current = id;
    setCurrentDocId(id);
    // A new preview document hasn't booted yet.
    setBooted(false);
    // Intentionally do NOT clear `recentSeenRef` here. The dedup map is
    // time-based (DEDUPE_WINDOW_MS) and cross-docId: clearing it on every
    // rebuild lets the same "Missing ./main.js" spam the panel once per
    // preview iteration while the agent is still streaming files in. Old
    // entries naturally expire.
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
    recentSeenRef.current.clear();
    setBooted(false);
  }, []);

  const actionable = useMemo(
    () =>
      entries.filter(
        (d) =>
          isActionable(d) &&
          // Drop the write-ordering race artifact: a "Missing local asset"
          // compile-error from an OLDER build that a newer build has since
          // superseded (the agent wrote index.html first, main.js after).
          !(isMissingAssetError(d) && d.docId < currentDocId),
      ),
    [entries, currentDocId],
  );

  useEffect(() => {
    const handler = (e: MessageEvent) => pushFromIframe(e);
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [pushFromIframe]);

  return {
    entries,
    actionable,
    booted,
    push,
    pushFromIframe,
    setDocId,
    clear,
  };
}

export type PreviewDiagnostics = ReturnType<typeof usePreviewDiagnostics>;
