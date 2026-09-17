import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VirtualFSHandle } from "./useVirtualFS";
import type { PreviewDiagnostics, Diagnostic } from "./usePreviewDiagnostics";
import { isMissingAssetError } from "./usePreviewDiagnostics";
import { selectInlineContext, decideAutoFix } from "../lib/autofix";
import { generateStickerIcon, svgToDataUrl } from "../lib/sticker";

const MAX_TOOL_ROUNDS = 12;
const DEFAULT_MAX_AUTO_FIX_ATTEMPTS = 3;
const STABILITY_WINDOW_MS = 1500;

interface UseAgentChatOptions {
  accessToken: string | null;
  vfs: VirtualFSHandle;
  modelRef: React.RefObject<string | null>;
  diagnostics?: PreviewDiagnostics;
  maxAutoFixAttempts?: number;
  /**
   * Called when the agent invokes the `show_preview` tool at the end
   * of a turn. The parent is expected to flip the right pane to the
   * Preview tab. Optional - if omitted, the tool is a no-op and
   * returns a neutral result to the agent.
   */
  onShowPreview?: () => void;
}

export interface AutoFixState {
  attempts: number;
  maxAttempts: number;
  active: boolean;
  stoppedReason?: "max-attempts" | "no-progress" | null;
}

interface ToolCall {
  toolName: string;
  args: unknown;
  toolCallId: string;
  dynamic?: boolean;
}

function formatDiagnosticForAgent(d: Diagnostic): string {
  const loc =
    d.file && d.line
      ? ` (${d.file}:${d.line}${d.col ? ":" + d.col : ""})`
      : "";
  const kind = d.kind === "compile-error" ? "Compile" : "Runtime";
  const stack = d.stack ? `\n  stack: ${d.stack.split("\n").slice(0, 3).join(" | ")}` : "";
  return `- [${kind}] ${d.message}${loc}${stack}`;
}

function executeEditorToolCall(
  tc: ToolCall,
  vfs: VirtualFSHandle,
  diagnostics: PreviewDiagnostics | undefined,
  onShowPreview: (() => void) | undefined,
): string | { error: string } {
  const { toolName } = tc;
  // LLMs occasionally emit tool calls with no `input` or an input that
  // doesn't match the schema. Destructuring those directly throws and
  // leaves the tool stuck in `input-available` forever, so we normalise
  // to an empty object up front and let each case validate what it needs.
  const args = (tc.args ?? {}) as Record<string, unknown>;

  switch (toolName) {
    case "write_file": {
      const path = typeof args.path === "string" ? args.path : "";
      const content = typeof args.content === "string" ? args.content : null;
      if (!path) return { error: "Missing `path`" };
      if (content === null) return { error: "Missing `content`" };
      vfs.writeFile(path, content);
      return `Wrote ${content.length} chars to ${path}`;
    }

    case "edit_file": {
      const path = typeof args.path === "string" ? args.path : "";
      const old_string =
        typeof args.old_string === "string" ? args.old_string : null;
      const new_string =
        typeof args.new_string === "string" ? args.new_string : null;
      if (!path) return { error: "Missing `path`" };
      if (old_string === null) return { error: "Missing `old_string`" };
      if (new_string === null) return { error: "Missing `new_string`" };
      const res = vfs.editFile(path, old_string, new_string);
      if (!res.ok) return { error: res.error ?? "Edit failed" };
      return `Edited ${path}`;
    }

    case "delete_file": {
      const path = typeof args.path === "string" ? args.path : "";
      if (!path) return { error: "Missing `path`" };
      const res = vfs.deleteFile(path);
      if (!res.ok) return { error: res.error ?? "Delete failed" };
      return `Deleted ${path}`;
    }

    case "read_file": {
      const path = typeof args.path === "string" ? args.path : "";
      if (!path) return { error: "Missing `path`" };
      const file = vfs.readFile(path);
      if (!file) return { error: `File "${path}" does not exist` };
      return file.content;
    }

    case "list_files": {
      const list = vfs.listFiles();
      if (list.length === 0) return "(virtual FS is empty)";
      return list
        .map((f) => `- ${f.path} (${f.content.length} bytes)`)
        .join("\n");
    }

    case "read_console_logs": {
      if (!diagnostics) return "(diagnostics not available)";
      const { limit } = args as { limit?: number };
      const n =
        typeof limit === "number" && limit > 0 && limit <= 100 ? limit : 20;
      const entries = diagnostics.entries
        .filter((e) => e.kind !== "ready")
        .slice(0, n);
      if (entries.length === 0) return "(no diagnostics)";
      return entries.map(formatDiagnosticForAgent).join("\n");
    }

    case "show_preview": {
      if (onShowPreview) {
        try {
          onShowPreview();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: `show_preview handler threw: ${msg}` };
        }
        return "Preview tab is now active.";
      }
      return "(no-op: the preview tab hook is not wired on this client)";
    }

    default:
      return { error: `Unknown client-side tool: ${toolName}` };
  }
}

/**
 * When the user interrupts the agent mid-turn, the SDK leaves any
 * in-flight tool parts in a non-terminal state (`input-streaming` or
 * `input-available`) - the backend emitted a tool_call but we never
 * produced a matching tool_result. The OpenAI-compatible chat APIs
 * (OpenRouter, etc.) reject follow-up requests whose history has
 * unbalanced tool_calls, so we must heal the history before the
 * next send.
 *
 * We DROP each dangling tool part (rather than resolving it to
 * `output-error`). Rationale:
 *   1. History stays balanced: no tool_call left to balance.
 *   2. Dropped calls don't retroactively satisfy the SDK's
 *      `lastAssistantMessageIsCompleteWithToolCalls` auto-continue
 *      predicate, which would otherwise race with the user's new
 *      message.
 *   3. The streaming overlay clears naturally (we only watch
 *      `input-streaming` tool parts).
 *
 * Any already-completed tool calls and any text/reasoning parts
 * earlier in the same message are preserved, so the user still sees
 * what the agent said or did before the cut.
 *
 * If the message ends up with nothing left (all parts were dangling
 * tool calls, no prose yet), the whole message is removed.
 *
 * Returns the same array reference when no patching is needed.
 */
function pruneDanglingToolParts(messages: UIMessage[]): UIMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return messages;

  const parts = last.parts ?? [];
  let dropped = 0;
  const kept = parts.filter((part) => {
    const p = part as { type: string; state?: string };
    if (typeof p.type !== "string" || !p.type.startsWith("tool-")) return true;
    if (p.state === "output-available" || p.state === "output-error") {
      return true;
    }
    dropped += 1;
    return false;
  });

  if (dropped === 0) return messages;

  if (kept.length === 0) {
    return messages.slice(0, -1);
  }

  return [...messages.slice(0, -1), { ...last, parts: kept } as UIMessage];
}

/**
 * Simple FNV-1a-ish hash of the current VFS snapshot. Used by the
 * auto-fix loop to detect "no progress": if two consecutive auto-fix
 * attempts leave the VFS byte-identical, we give up instead of looping.
 */
function hashVfs(files: { path: string; content: string }[]): string {
  let h = 0x811c9dc5;
  const parts = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => `${f.path}:${f.content.length}:${f.content}`);
  const joined = parts.join("\u0001");
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function diagType(d: Diagnostic): string {
  switch (d.kind) {
    case "compile-error":
      return "compile";
    case "unhandledrejection":
      return "rejection";
    case "console.error":
      return "console.error";
    case "console.warn":
      return "console.warn";
    default:
      return "runtime";
  }
}

/**
 * Structured, per-error line for the auto-fix message:
 *   - [severity/type, origin] (file:line) message
 * so the model sees WHAT kind of error it is and WHERE it came from.
 */
function formatDiagnostic(d: Diagnostic): string {
  const loc =
    d.file && d.line
      ? ` (${d.file}:${d.line}${d.col ? ":" + d.col : ""})`
      : "";
  const sev = d.severity ?? "error";
  const origin = d.origin ? `, ${d.origin}` : "";
  return `- [${sev}/${diagType(d)}${origin}]${loc} ${d.message}`;
}

/**
 * Stable signature of the current ACTIONABLE error set (order-independent).
 * Same FNV-1a core as `hashVfs`. Used to detect "the edits changed the
 * files but the same errors persist" -> stop and hand off to a human.
 */
function errorSetSig(diags: Diagnostic[]): string {
  let h = 0x811c9dc5;
  const joined = diags
    .map((d) => `${d.kind}::${d.message}::${d.file ?? ""}::${d.line ?? ""}`)
    .sort()
    .join("\u0001");
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function useAgentChat({
  accessToken,
  vfs,
  modelRef,
  diagnostics,
  maxAutoFixAttempts = DEFAULT_MAX_AUTO_FIX_ATTEMPTS,
  onShowPreview,
}: UseAgentChatOptions) {
  const vfsRef = useRef(vfs);
  vfsRef.current = vfs;

  const diagnosticsRef = useRef<PreviewDiagnostics | undefined>(diagnostics);
  diagnosticsRef.current = diagnostics;

  // The onShowPreview callback changes reference on every App render
  // (it's usually an inline arrow); reading through a ref keeps
  // `onToolCall` stable and avoids spurious chat re-registration.
  const onShowPreviewRef = useRef(onShowPreview);
  onShowPreviewRef.current = onShowPreview;

  // Keep the latest token in a ref so the transport `headers` callback
  // always reads the current value - otherwise `useChat` captures a stale
  // closure from the very first render (when the user isn't signed in yet)
  // and every request goes out as anonymous -> 401.
  const tokenRef = useRef(accessToken);
  tokenRef.current = accessToken;

  const [input, setInput] = useState("");
  // Sticker previews keyed by toolCallId: filled when `generate_app_icon`
  // succeeds so the chat can show the generated icon inline WITHOUT sending a
  // heavy data URL back into the model's context (the tool output stays a
  // short string).
  const [iconPreviews, setIconPreviews] = useState<Map<string, string>>(
    () => new Map(),
  );
  // Aborts an in-flight `generate_app_icon` run (the only long-running,
  // client-side tool). `interrupt()` fires it so a user stop/cancel tears down
  // the fetch + poll timers immediately and lets the handler settle the tool
  // call (addToolResult) instead of leaving the SDK waiting for ~120s.
  const iconAbortRef = useRef<AbortController | null>(null);
  const [autoFix, setAutoFix] = useState<AutoFixState>({
    attempts: 0,
    maxAttempts: maxAutoFixAttempts,
    active: false,
    stoppedReason: null,
  });

  const attemptsRef = useRef(0);
  const autoFixActiveRef = useRef(false);
  const stabilityTimerRef = useRef<number | null>(null);
  const lastVfsHashRef = useRef<string | null>(null);
  // Signature of the actionable error set from the previous attempt. Lets
  // us stop when the model edited files (VFS changed) but the exact same
  // errors persist - retrying further is unlikely to help.
  const lastErrorSigRef = useRef<string | null>(null);
  const lastStatusRef = useRef<string>("ready");

  const clearStabilityTimer = useCallback(() => {
    if (stabilityTimerRef.current !== null) {
      window.clearTimeout(stabilityTimerRef.current);
      stabilityTimerRef.current = null;
    }
  }, []);

  const resetAutoFix = useCallback(() => {
    clearStabilityTimer();
    attemptsRef.current = 0;
    autoFixActiveRef.current = false;
    lastVfsHashRef.current = null;
    lastErrorSigRef.current = null;
    setAutoFix({
      attempts: 0,
      maxAttempts: maxAutoFixAttempts,
      active: false,
      stoppedReason: null,
    });
    diagnosticsRef.current?.clear();
  }, [clearStabilityTimer, maxAutoFixAttempts]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        headers: (): Record<string, string> =>
          tokenRef.current
            ? { Authorization: `Bearer ${tokenRef.current}` }
            : {},
      }),
    [],
  );

  // Mirrors `chat.status` into a ref. `chat.status` comes from a
  // `useSyncExternalStore`, so it's a render-time snapshot - async code
  // that needs the *current* status (queue drainer, timer callbacks,
  // etc) reads from this ref instead.
  const chatStatusRef = useRef<string>("ready");

  const { addToolResult, ...chat } = useChat({
    transport,
    sendAutomaticallyWhen: ({ messages }) => {
      let toolRounds = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== "assistant") break;
        const hasToolPart = (m.parts ?? []).some(
          (p) => typeof p.type === "string" && p.type.startsWith("tool-"),
        );
        if (!hasToolPart) break;
        toolRounds += 1;
      }
      if (toolRounds >= MAX_TOOL_ROUNDS) return false;
      return lastAssistantMessageIsCompleteWithToolCalls({ messages });
    },

    async onToolCall({ toolCall }) {
      if (toolCall.dynamic) return;

      // `read_skill_doc` is executed server-side (see backend tools.ts).
      // Only the editor tools are handled here.
      const clientSideTools = new Set([
        "write_file",
        "edit_file",
        "delete_file",
        "read_file",
        "list_files",
        "read_console_logs",
        "show_preview",
        "generate_app_icon",
      ]);
      if (!clientSideTools.has(toolCall.toolName as string)) return;

      // `generate_app_icon` is the one ASYNC client-side tool: it calls the
      // sticker service and polls to completion (~60s). Handle it on its own
      // path, then fall through to addToolResult like the sync tools.
      if (toolCall.toolName === "generate_app_icon") {
        let output: string;
        try {
          const args = (toolCall.input ?? {}) as { prompt?: unknown };
          const prompt =
            typeof args.prompt === "string" ? args.prompt.trim() : "";
          if (!prompt) {
            output =
              "ERROR: missing `prompt`. Pass a short Reachy-themed description.";
          } else {
            // One controller per run so a user cancel (interrupt) aborts the
            // fetch + poll loop and this promise resolves right away.
            const controller = new AbortController();
            iconAbortRef.current = controller;
            let res;
            try {
              res = await generateStickerIcon(prompt, {
                signal: controller.signal,
              });
            } finally {
              if (iconAbortRef.current === controller) {
                iconAbortRef.current = null;
              }
            }
            if (!res.ok && res.reason === "cancelled") {
              output =
                "Icon generation was cancelled by the user. Kept the current " +
                "icon; you can offer to generate one again if they want.";
            } else if (res.ok && res.svg) {
              vfsRef.current.writeFile("icon.svg", res.svg);
              try {
                setIconPreviews((prev) => {
                  const next = new Map(prev);
                  next.set(toolCall.toolCallId, svgToDataUrl(res.svg!));
                  return next;
                });
              } catch {
                /* preview is best-effort */
              }
              output =
                `Generated a custom Reachy icon (${res.svg.length} bytes) and wrote it to ` +
                `icon.svg. It now shows in the preview top bar and will be committed on ` +
                `publish. The user can see the sticker in the chat.`;
            } else {
              output =
                `Could not generate a custom icon (${res.reason ?? "unknown error"}). ` +
                `Kept the default "reachy simple" icon - tell the user, and offer to retry.`;
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          output =
            `Could not generate a custom icon (${msg}). Kept the default icon; offer to retry.`;
        }
        try {
          (addToolResult as (a: {
            tool: string;
            toolCallId: string;
            output: unknown;
          }) => void)({
            tool: toolCall.toolName as string,
            toolCallId: toolCall.toolCallId,
            output,
          });
        } catch (err) {
          console.error("[agent] addToolResult threw (generate_app_icon)", err);
        }
        return;
      }

      // CRITICAL: this handler MUST reach `addToolResult` no matter what,
      // otherwise the tool part stays forever in `input-available` and
      // the UI hangs with "Reading file..." / "Writing file..." etc.
      // The SDK doesn't auto-rescue us from a thrown `onToolCall`, so we
      // trap every failure path and surface it as a plain error string
      // back to the agent (who can then recover on the next turn).
      let output: unknown;
      try {
        const result = executeEditorToolCall(
          {
            toolName: toolCall.toolName as string,
            args: toolCall.input,
            toolCallId: toolCall.toolCallId,
          },
          vfsRef.current,
          diagnosticsRef.current,
          onShowPreviewRef.current,
        );
        output =
          typeof result === "string" ? result : `ERROR: ${result.error}`;
      } catch (err) {
        console.error("[agent] tool execution threw", {
          tool: toolCall.toolName,
          err,
        });
        const msg = err instanceof Error ? err.message : String(err);
        output = `ERROR: tool "${toolCall.toolName}" threw: ${msg}`;
      }

      try {
        (addToolResult as (args: {
          tool: string;
          toolCallId: string;
          output: unknown;
        }) => void)({
          tool: toolCall.toolName as string,
          toolCallId: toolCall.toolCallId,
          output,
        });
      } catch (err) {
        console.error("[agent] addToolResult threw", {
          tool: toolCall.toolName,
          err,
        });
      }
    },

    onError(error) {
      console.error("[agent] chat error:", error);
    },
  });

  // ------------------------------------------------------------------
  // Serial dispatch queue
  // ------------------------------------------------------------------
  //
  // Every path that sends a message to the agent (user, auto-fix,
  // plan approval, future callers) funnels through `dispatch`. The
  // drainer pops one item at a time, awaits the full turn (including
  // all recursive SDK auto-sends), then waits for the chat to settle
  // back to `ready` before processing the next item.
  //
  // This is a hard requirement, not a defensive measure: `ai@6`'s
  // `Chat` class tracks a single `activeResponse` field, and any two
  // `makeRequest` invocations overlapping will crash with
  // `Cannot read properties of undefined (reading 'state')` once the
  // faster one clears the field from under the slower one's finally
  // block. By serialising at our layer we make that impossible by
  // construction, regardless of how many call sites exist.

  type DispatchItem = {
    id: number;
    text: string;
  };

  const dispatchQueueRef = useRef<DispatchItem[]>([]);
  const isDrainingRef = useRef(false);
  const dispatchIdRef = useRef(0);

  const buildSendOptions = useCallback(() => {
    // Send a lean manifest (path + size) AND the actual file contents
    // when they fit the budget, so the backend can inline them into the
    // system prompt as `<useful-context>` and the model uses edit_file
    // instead of rewriting from a truncated view. Pure selection lives
    // in `selectInlineContext` (unit-tested).
    const context = { files: selectInlineContext(vfsRef.current.getAll()) };

    // Forward the knowledge text persisted in localStorage (see
    // TopBar's Knowledge modal). The backend injects it verbatim
    // in the prompt.
    let knowledge: string | undefined;
    try {
      knowledge = localStorage.getItem("reachy-vibe-knowledge") || undefined;
    } catch {
      knowledge = undefined;
    }

    return {
      body: { context, knowledge, model: modelRef.current },
    } as const;
  }, [modelRef]);

  // Resolve once the chat is back in a dispatchable state. Polls at a
  // cheap 50ms cadence; status transitions happen on human-perceivable
  // timescales so the wasted wake-ups are negligible and this avoids
  // hooking into the SDK's private event emitters.
  //
  // A hard timeout ensures the drainer can't hang forever if the SDK
  // gets stuck in `submitted`/`streaming` (e.g. hung fetch, network
  // split, upstream backend frozen). After the timeout we resolve
  // anyway - the next `sendMessage` will either succeed or surface
  // the real error to the user.
  const WAIT_READY_TIMEOUT_MS = 90_000;
  const waitForChatReady = useCallback(async () => {
    const deadline = Date.now() + WAIT_READY_TIMEOUT_MS;
    while (
      chatStatusRef.current !== "ready" &&
      chatStatusRef.current !== "error"
    ) {
      if (Date.now() > deadline) {
        console.warn(
          "[agent] waitForChatReady timed out after",
          WAIT_READY_TIMEOUT_MS,
          "ms - chat stuck in",
          chatStatusRef.current,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }, []);

  const drainQueue = useCallback(async () => {
    if (isDrainingRef.current) return;
    isDrainingRef.current = true;
    try {
      while (dispatchQueueRef.current.length > 0) {
        // Block until any in-flight request (including background
        // `makeRequest`s fired by `addToolOutput`) completes.
        await waitForChatReady();

        const item = dispatchQueueRef.current.shift();
        if (!item) break;

        try {
          const options = buildSendOptions();
          // `sendMessage` awaits `makeRequest`, which awaits its own
          // recursive `makeRequest` chain (via `sendAutomaticallyWhen`).
          // When it resolves, the main turn is done.
          await chat.sendMessage({ text: item.text }, options);
        } catch (err) {
          console.error("[agent] sendMessage failed", { id: item.id, err });
        }

        // The SDK's `addToolOutput` may fire a fire-and-forget
        // `makeRequest` that is NOT part of the awaited chain above.
        // Yield a microtask tick, then wait for the chat to settle
        // again before processing the next queued item.
        await new Promise((r) => setTimeout(r, 0));
        await waitForChatReady();
      }
    } finally {
      isDrainingRef.current = false;
    }
  }, [buildSendOptions, chat, waitForChatReady]);

  const dispatch = useCallback(
    (text: string) => {
      const id = ++dispatchIdRef.current;
      dispatchQueueRef.current.push({ id, text });
      void drainQueue();
    },
    [drainQueue],
  );

  const clearDispatchQueue = useCallback(() => {
    dispatchQueueRef.current = [];
  }, []);

  const sendAutoFix = useCallback(
    (errors: Diagnostic[], attempt: number, max: number) => {
      const errorList = errors.slice(0, 10).map(formatDiagnostic).join("\n");
      const fileList =
        vfsRef.current
          .getAll()
          .map((f) => f.path)
          .join(", ") || "(empty)";
      const message =
        `[auto-fix attempt ${attempt}/${max}] The preview reported these ACTIONABLE errors after your last edit ` +
        `(each line is \`- [severity/type, origin] (file:line) message\`; environmental/preview-only noise has already been filtered out):\n\n` +
        `${errorList}\n\n` +
        `Current files: ${fileList}\n\n` +
        `Apply the SMALLEST possible fix:\n` +
        `- If a file's current contents are not shown in useful-context, call \`read_file\` on it FIRST so you edit against the real text.\n` +
        `- Then use \`edit_file\` with a minimal, uniquely-matching diff. Do NOT rewrite a whole file with \`write_file\` unless its structure genuinely must change.`;
      dispatch(message);
    },
    [dispatch],
  );

  // Hard interrupt: abort any in-flight stream, drop all queued
  // work, and rewrite history so the next request is valid.
  //
  // This is the single source of truth for "make the agent shut up
  // right now". Both the user-facing stop button and a fresh
  // sendMessage-during-flight go through here.
  const interrupt = useCallback(() => {
    // 0. Abort any in-flight client-side icon generation FIRST. Without this
    //    the `generate_app_icon` handler stays parked on its ~120s poll, never
    //    reaches `addToolResult`, and the SDK hangs waiting for the tool
    //    result (frozen "thinking", dead composer). Aborting makes
    //    generateStickerIcon return `cancelled` immediately (clearing its
    //    fetch + timers), so the handler settles the tool call and the chat
    //    returns to `ready`.
    try {
      iconAbortRef.current?.abort();
      iconAbortRef.current = null;
    } catch (err) {
      console.warn("[agent] icon abort threw", err);
    }

    // 1. Abort the fetch. The SDK transitions to `ready` or `error`
    //    and the awaited `chat.sendMessage` in drainQueue rejects,
    //    unwinding the drainer loop.
    try {
      chat.stop();
    } catch (err) {
      console.warn("[agent] chat.stop() threw", err);
    }

    // 2. Drop any queued follow-ups (auto-fix retries, subsequent
    //    user messages typed while the stop was pending, etc.).
    clearDispatchQueue();
    resetAutoFix();

    // 3. Heal the conversation history: drop any tool parts that
    //    never produced a result, and remove the whole assistant
    //    message if it was just a stub. Without this the next
    //    request is rejected upstream for unbalanced tool calls
    //    AND the SDK could auto-fire a second makeRequest that
    //    races with the user's new sendMessage.
    try {
      const patched = pruneDanglingToolParts(chat.messages as UIMessage[]);
      if (patched !== (chat.messages as UIMessage[])) {
        chat.setMessages(patched);
      }
    } catch (err) {
      console.error("[agent] failed to prune dangling tool parts", err);
    }
  }, [chat, clearDispatchQueue, resetAutoFix]);

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      // If the agent is still working, the user's new message
      // supersedes everything in flight. Abort, clean up, then queue.
      const busy =
        chatStatusRef.current === "streaming" ||
        chatStatusRef.current === "submitted" ||
        isDrainingRef.current ||
        dispatchQueueRef.current.length > 0 ||
        autoFix.active;
      if (busy) {
        interrupt();
      } else {
        // Even when idle, cancel any stale auto-fix scheduling.
        clearDispatchQueue();
        resetAutoFix();
      }

      dispatch(trimmed);
      setInput("");
    },
    [autoFix.active, clearDispatchQueue, dispatch, interrupt, resetAutoFix],
  );

  // Keep the status ref fresh on every render. The queue drainer and
  // the auto-fix timer callback both read it to decide when to act.
  chatStatusRef.current = chat.status;

  // ------------------------------------------------------------------
  // Streaming file overlays (v0/Lovable-style "watch the code appear")
  // ------------------------------------------------------------------
  //
  // While the model streams a `write_file` tool call, the SDK exposes
  // the partial `input.content` as it's incrementally parsed from the
  // JSON payload. We mirror that partial content into a dedicated
  // overlay map so the code editor can show the file filling up live.
  //
  // The overlay is NOT merged into the VFS - that would re-trigger
  // the preview iframe rebuild on every chunk with syntactically
  // broken code, which spams compile errors. Only the final
  // `input-available` state fires `onToolCall`, which commits to the
  // VFS once and triggers exactly one preview rebuild.
  //
  // Ref-then-state pattern: we keep the map in a ref (single source of
  // truth, stable JSON-stringified signature) and only call
  // `setStreamingFiles` when the signature actually changes, so we
  // don't thrash React on every identical re-derivation.

  const [streamingFiles, setStreamingFiles] = useState<Map<string, string>>(
    () => new Map(),
  );
  const streamingSignatureRef = useRef<string>("");

  useEffect(() => {
    const next = new Map<string, string>();
    for (const msg of chat.messages) {
      if (msg.role !== "assistant") continue;
      for (const part of msg.parts ?? []) {
        const p = part as {
          type: string;
          state?: string;
          input?: Record<string, unknown>;
        };
        if (typeof p.type !== "string" || !p.type.startsWith("tool-")) {
          continue;
        }
        if (p.state !== "input-streaming") continue;
        const toolName = p.type.slice("tool-".length);
        if (toolName !== "write_file") continue;
        const path = p.input?.path;
        const content = p.input?.content;
        if (typeof path === "string" && path && typeof content === "string") {
          next.set(path, content);
        }
      }
    }

    // Stable signature: sorted `path:length` pairs. Length is enough
    // because content is append-only during streaming, so a changed
    // length always means a changed suffix.
    const sig = [...next.entries()]
      .map(([k, v]) => `${k}:${v.length}`)
      .sort()
      .join("|");
    if (sig === streamingSignatureRef.current) return;
    streamingSignatureRef.current = sig;
    setStreamingFiles(next);
  }, [chat.messages]);

  // Path the agent is currently touching (any file-scoped tool, not
  // just write_file). We expose this so the editor can auto-focus
  // the matching tab when `edit_file` / `read_file` / `delete_file`
  // runs too - not only during `write_file` streaming. We take the
  // LAST such part in chronological order so each new tool call
  // shifts the spotlight.
  const [focusedFilePath, setFocusedFilePath] = useState<string | null>(null);
  const focusedSignatureRef = useRef<string>("");

  useEffect(() => {
    const FILE_SCOPED_TOOLS = new Set([
      "write_file",
      "edit_file",
      "delete_file",
      "read_file",
    ]);
    let lastPath: string | null = null;
    let lastSig = "";
    for (const msg of chat.messages) {
      if (msg.role !== "assistant") continue;
      for (const part of msg.parts ?? []) {
        const p = part as {
          type: string;
          state?: string;
          input?: Record<string, unknown>;
        };
        if (typeof p.type !== "string" || !p.type.startsWith("tool-")) continue;
        const toolName = p.type.slice("tool-".length);
        if (!FILE_SCOPED_TOOLS.has(toolName)) continue;
        const path = p.input?.path;
        if (typeof path !== "string" || !path) continue;
        // Any state (input-streaming, input-available, output-*) is a
        // valid signal that the agent is attending to this file.
        lastPath = path;
        lastSig = `${toolName}:${path}:${p.state ?? ""}`;
      }
    }
    if (lastSig === focusedSignatureRef.current) return;
    focusedSignatureRef.current = lastSig;
    setFocusedFilePath(lastPath);
  }, [chat.messages]);

  // Auto-fix loop: when the agent finishes a turn, wait for the preview
  // to settle and check for actionable runtime/compile errors. If any
  // remain, push an auto-fix prompt onto the dispatch queue. Stops
  // after N attempts, or when the VFS hash hasn't changed since the
  // previous attempt (no progress).
  useEffect(() => {
    if (!diagnostics) return;
    const prevStatus = lastStatusRef.current;
    const curr = chat.status;
    lastStatusRef.current = curr;

    // If the chat leaves `ready` (SDK auto-send, new user turn, error...)
    // any pending stability timer is stale - a new `ready` transition
    // will restart it. This prevents us from racing against a request
    // already in flight.
    if (curr !== "ready") {
      clearStabilityTimer();
      return;
    }

    const wasBusy = prevStatus === "streaming" || prevStatus === "submitted";
    if (!wasBusy) return;

    clearStabilityTimer();
    stabilityTimerRef.current = window.setTimeout(() => {
      stabilityTimerRef.current = null;

      // The dispatch queue will serialise us behind any in-flight turn,
      // but we still bail early if the chat hasn't been idle for the
      // full stability window: during streaming the diagnostic batch
      // isn't meaningful yet.
      if (chatStatusRef.current !== "ready") return;

      const diag = diagnosticsRef.current;
      if (!diag) return;
      const actionable = diag.actionable;

      // Snapshot refs into pure memory, decide, commit back. All the
      // termination logic lives in `decideAutoFix` (unit + property tested).
      const { decision, memory } = decideAutoFix(
        {
          attempts: attemptsRef.current,
          active: autoFixActiveRef.current,
          lastVfsHash: lastVfsHashRef.current,
          lastErrorSig: lastErrorSigRef.current,
        },
        {
          actionableCount: actionable.length,
          actionableAllMissingAsset:
            actionable.length > 0 && actionable.every(isMissingAssetError),
          booted: diag.booted,
          vfsHash: hashVfs(vfsRef.current.getAll()),
          errorSig: errorSetSig(actionable),
          maxAttempts: maxAutoFixAttempts,
        },
      );

      attemptsRef.current = memory.attempts;
      autoFixActiveRef.current = memory.active;
      lastVfsHashRef.current = memory.lastVfsHash;
      lastErrorSigRef.current = memory.lastErrorSig;

      if (decision.kind === "success") {
        setAutoFix((s) => ({ ...s, active: false, stoppedReason: null }));
        return;
      }
      if (decision.kind === "stop") {
        setAutoFix((s) => ({
          ...s,
          active: false,
          stoppedReason: decision.reason,
        }));
        return;
      }

      setAutoFix({
        attempts: decision.attempt,
        maxAttempts: maxAutoFixAttempts,
        active: true,
        stoppedReason: null,
      });

      // Snapshot the actionable errors now; subsequent iframe flushes
      // will populate the next batch for the next attempt (if any).
      const snapshot = [...actionable];
      diag.clear();
      sendAutoFix(snapshot, decision.attempt, maxAutoFixAttempts);
    }, STABILITY_WINDOW_MS);

    return () => {
      // Don't clear on unmount/re-render because the transition is what
      // we care about; `clearStabilityTimer` is called from user actions
      // and from the timer itself.
    };
  }, [
    chat.status,
    diagnostics,
    clearStabilityTimer,
    maxAutoFixAttempts,
    sendAutoFix,
  ]);

  const clearMessages = useCallback(() => {
    // Abort any in-flight stream first. Otherwise the SDK may keep
    // appending to the freshly-emptied message array as chunks arrive,
    // leaving the user wondering why ghost tool calls are popping up.
    interrupt();
    chat.setMessages([]);
  }, [chat, interrupt]);

  // User-facing stop button shares the same path as the implicit
  // interrupt fired on sendMessage-during-flight.
  const stop = useCallback(() => {
    interrupt();
  }, [interrupt]);

  return {
    messages: chat.messages as UIMessage[],
    status: chat.status,
    isLoading:
      chat.status === "streaming" ||
      chat.status === "submitted" ||
      autoFix.active,
    error: chat.error,
    stop,
    sendMessage,
    clearMessages,
    input,
    setInput,
    autoFix,
    streamingFiles,
    focusedFilePath,
    iconPreviews,
  };
}
