import type { UIMessage } from "ai";
import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { deriveAgentStatus, type AgentStatus } from "../utils/agent-status";

function InlineThinking({ status }: { status: AgentStatus }) {
  return (
    <div className="chat-thinking" role="status" aria-live="polite">
      <span className="chat-thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="chat-thinking-label">{status.label}</span>
      {status.detail && (
        <span className="chat-thinking-detail mono">· {status.detail}</span>
      )}
    </div>
  );
}

interface ChatPanelProps {
  messages: UIMessage[];
  isLoading: boolean;
  input: string;
  setInput: (v: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  error: Error | null;
  autoFix?: {
    attempts: number;
    maxAttempts: number;
    active: boolean;
    stoppedReason?: "max-attempts" | "no-progress" | null;
  };
  /** toolCallId -> data URL of a generated app icon, for inline chat preview. */
  iconPreviews?: Map<string, string>;
}

const AUTOFIX_PREFIX = "[auto-fix attempt";
const AUTOFIX_ATTEMPT_RE = /^\[auto-fix attempt (\d+)\/(\d+)\]/;

function getAutoFixMeta(
  m: UIMessage,
): { attempt: number; max: number } | null {
  if (m.role !== "user") return null;
  const first = (m.parts ?? []).find(
    (p) => (p as { type: string }).type === "text",
  ) as { text?: string } | undefined;
  const text = first?.text ?? "";
  if (!text.startsWith(AUTOFIX_PREFIX)) return null;
  const match = AUTOFIX_ATTEMPT_RE.exec(text);
  if (!match) return { attempt: 0, max: 0 };
  return { attempt: Number(match[1]), max: Number(match[2]) };
}

const EXAMPLE_PROMPTS = [
  "Add a joystick on-screen that drives the head pose continuously while I drag it.",
  "Make the antennas react to the robot mic volume using the Web Audio API.",
  "Add a small 'dance' button that plays a scripted sequence of head poses for ~5 seconds.",
];

function renderMessagePart(
  part: UIMessage["parts"][number],
  idx: number,
  iconPreviews?: Map<string, string>,
): React.ReactNode {
  const type = part.type;

  if (type === "text") {
    const text = (part as { text: string }).text;
    if (!text.trim()) return null;
    return (
      <div key={idx} className="bubble-agent-text markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    );
  }

  if (typeof type === "string" && type.startsWith("tool-")) {
    const toolPart = part as {
      type: string;
      state?: string;
      input?: Record<string, unknown>;
      output?: unknown;
      errorText?: string;
      toolCallId?: string;
    };
    const toolName = type.slice("tool-".length);
    const state = toolPart.state ?? "unknown";
    const isDone = state === "output-available" || state === "result";
    const isError = state === "output-error" || state === "error";
    const isPending = !isDone && !isError;
    const statusClass = isDone
      ? "status-done"
      : isError
        ? "status-error"
        : "status-pending";

    const isStreaming = state === "input-streaming";
    const detail = extractToolDetail(toolName, toolPart.input);

    // Inline preview of a generated app icon (data URL kept out of the model
    // context; see useAgentChat.iconPreviews).
    const iconDataUrl =
      toolName === "generate_app_icon" && toolPart.toolCallId
        ? iconPreviews?.get(toolPart.toolCallId)
        : undefined;

    return (
      <div key={idx} className={`bubble-tool ${statusClass}`}>
        <div className="bubble-tool-header">
          {isPending ? (
            <span className="tool-spinner" aria-label="in progress" />
          ) : (
            <span className="dot" />
          )}
          <span>{toolLabel(toolName)}</span>
          {detail && (
            <span className="mono bubble-tool-detail-inline">
              · {detail}
              {isStreaming ? "…" : ""}
            </span>
          )}
        </div>
        {iconDataUrl && (
          <div className="bubble-tool-icon-preview">
            <img src={iconDataUrl} alt="Generated app icon" width={96} height={96} />
          </div>
        )}
        {toolPart.errorText && (
          <div className="bubble-tool-detail">{toolPart.errorText}</div>
        )}
      </div>
    );
  }

  return null;
}

function extractToolDetail(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string {
  if (!input) return "";
  if (toolName === "write_file") {
    const parts: string[] = [];
    if (typeof input.path === "string" && input.path) parts.push(input.path);
    if (typeof input.content === "string") {
      parts.push(`${input.content.length.toLocaleString()} chars`);
    }
    return parts.join(" · ");
  }
  if (toolName === "edit_file") {
    const parts: string[] = [];
    if (typeof input.path === "string" && input.path) parts.push(input.path);
    if (typeof input.new_string === "string") {
      parts.push(`${input.new_string.length.toLocaleString()} chars`);
    }
    return parts.join(" · ");
  }
  if (
    (toolName === "read_file" || toolName === "delete_file") &&
    typeof input.path === "string"
  ) {
    return input.path;
  }
  if (toolName === "read_skill_doc" && typeof input.topic === "string") {
    return input.topic;
  }
  if (toolName === "generate_app_icon" && typeof input.prompt === "string") {
    const p = input.prompt;
    return p.length > 48 ? `${p.slice(0, 48)}…` : p;
  }
  return "";
}

function toolLabel(name: string): string {
  const map: Record<string, string> = {
    write_file: "Writing file",
    edit_file: "Editing file",
    delete_file: "Deleting file",
    read_file: "Reading file",
    list_files: "Listing files",
    read_skill_doc: "Loading skill chapter",
    read_console_logs: "Reading console logs",
    show_preview: "Opening preview",
    generate_app_icon: "Generating app icon",
  };
  return map[name] ?? name;
}

export function ChatPanel({
  messages,
  isLoading,
  input,
  setInput,
  onSend,
  onStop,
  error,
  autoFix,
  iconPreviews,
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    // Having text always wins, even while the agent is still streaming:
    // `onSend` interrupts the in-flight turn and queues ours. This is
    // the v0/Claude/ChatGPT pattern - users expect their new message
    // to supersede whatever the model was doing. No explicit stop
    // required.
    if (text) {
      onSend(text);
      return;
    }
    // Empty input + running agent -> the submit button acts as Stop.
    if (isLoading) {
      onStop();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const showEmpty = messages.length === 0;
  const agentStatus = deriveAgentStatus(messages, isLoading, autoFix ?? null);

  return (
    <aside className="chat-panel">
      <div className="chat-messages" ref={scrollRef}>
        {showEmpty && (
          <div className="chat-empty">
            <p>
              Describe the Reachy Mini app you want to build. The agent
              produces <strong>tiny static demos</strong> - 3 files
              (<code>index.html</code>, <code>main.js</code>,{" "}
              <code>README.md</code>), no build step, no server, HF login
              only. Pick a starting point below or write your own prompt.
            </p>
            <div className="chat-empty-caps">
              <span className="chat-empty-caps-title">You can ask it to</span>
              <ul className="chat-empty-caps-list">
                <li>Build &amp; edit the app files (HTML/JS)</li>
                <li>Generate a custom app icon (a Reachy sticker)</li>
                <li>Preview it live &amp; auto-fix console errors</li>
                <li>Publish it to a Hugging Face Space</li>
              </ul>
            </div>
            <div className="chat-empty-examples">
              {EXAMPLE_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="chat-empty-example"
                  disabled={isLoading}
                  onClick={() => {
                    if (isLoading) return;
                    setInput("");
                    onSend(p);
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {(() => {
          const seen = new Set<string>();
          return messages.map((m, idx) => {
            if (seen.has(m.id)) return null;
            seen.add(m.id);

            const autoFixMeta = getAutoFixMeta(m);
            if (autoFixMeta) {
              return (
                <div key={m.id} className="autofix-divider" role="note">
                  <span className="autofix-divider-line" aria-hidden="true" />
                  <span className="autofix-divider-label">
                    Auto-fix
                    {autoFixMeta.max > 0 && (
                      <>
                        {" "}
                        <span className="mono">
                          attempt {autoFixMeta.attempt}/{autoFixMeta.max}
                        </span>
                      </>
                    )}
                    <span className="autofix-divider-hint">
                      · preview errors sent back to the agent
                    </span>
                  </span>
                  <span className="autofix-divider-line" aria-hidden="true" />
                </div>
              );
            }

            const isLast = idx === messages.length - 1;
            const showInlineThinking =
              isLoading && agentStatus && isLast && m.role === "assistant";
            return m.role === "user" ? (
              <div key={m.id} className="bubble-user">
                {m.parts
                  .map((p) => ((p as { type: string }).type === "text" ? (p as { text: string }).text : ""))
                  .join("")}
              </div>
            ) : (
              <div key={m.id} className="bubble-agent">
                {m.parts.map((p, i) => renderMessagePart(p, i, iconPreviews))}
                {showInlineThinking && (
                  <InlineThinking status={agentStatus} />
                )}
              </div>
            );
          });
        })()}

        {isLoading &&
          agentStatus &&
          (messages.length === 0 ||
            messages[messages.length - 1].role !== "assistant") && (
            <div className="bubble-agent bubble-agent-placeholder">
              <InlineThinking status={agentStatus} />
            </div>
          )}

        {autoFix && !autoFix.active && autoFix.stoppedReason && (
          <div className="autofix-note">
            {autoFix.stoppedReason === "max-attempts"
              ? `Stopped after ${autoFix.maxAttempts} auto-fix attempts. Retry or rephrase.`
              : "Auto-fix stopped: no progress between attempts. Retry or rephrase."}
          </div>
        )}

        {error && (
          <div className="signin-error" style={{ alignSelf: "stretch" }}>
            {error.message}
          </div>
        )}
      </div>

      <form className="chat-composer" onSubmit={handleSubmit}>
        <div className="chat-composer-field">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe what to build or change…"
            rows={1}
          />
          {(() => {
            const hasText = input.trim().length > 0;
            const showStop = isLoading && !hasText;
            return (
              <button
                type="submit"
                className="chat-send"
                disabled={!isLoading && !hasText}
                title={
                  showStop
                    ? "Stop"
                    : isLoading
                      ? "Interrupt and send"
                      : "Send"
                }
              >
                {showStop ? "■" : "↑"}
              </button>
            );
          })()}
        </div>
        <div className="chat-composer-toolbar">
          <div className="chat-status" aria-live="polite">
            <span>Enter to send · Shift+Enter for newline</span>
          </div>
        </div>
      </form>
    </aside>
  );
}
