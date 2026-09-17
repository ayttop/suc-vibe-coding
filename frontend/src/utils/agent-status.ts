import type { UIMessage } from "ai";

/**
 * Derive a short "what is the agent doing right now" status from the
 * message stream. Returns `null` when the agent is idle.
 *
 * The indicator is voluntarily abstract - it never leaks a raw file
 * path or skill name. Instead it surfaces a verb describing the tool
 * plus a sub-phrase derived from the tool's streaming state:
 *   - `input-streaming` → "generating" (the model is still drafting
 *     the tool arguments)
 *   - `input-available`  → "applying"   (arguments are complete, the
 *     client tool handler is running)
 *
 * Auto-fix state takes precedence so the user can always see attempts.
 */
export interface AgentStatus {
  label: string;
  detail?: string;
}

interface AutoFixState {
  active: boolean;
  attempts: number;
  maxAttempts: number;
}

interface ToolStateLabels {
  label: string;
  streaming?: string;
  running?: string;
}

const TOOL_LABELS: Record<string, ToolStateLabels> = {
  write_file: {
    label: "Writing file",
    streaming: "generating",
    running: "applying",
  },
  edit_file: {
    label: "Editing file",
    streaming: "generating",
    running: "applying",
  },
  delete_file: {
    label: "Deleting file",
    running: "applying",
  },
  read_file: {
    label: "Reading file",
    running: "loading",
  },
  list_files: {
    label: "Listing files",
    running: "loading",
  },
  read_skill_doc: {
    label: "Reading docs",
    running: "loading",
  },
  read_console_logs: {
    label: "Reading logs",
    running: "loading",
  },
  show_preview: {
    label: "Opening preview",
    running: "loading",
  },
};

function toolStatus(
  toolName: string,
  state: string,
): AgentStatus {
  const info = TOOL_LABELS[toolName] ?? { label: toolName };
  const detail =
    state === "input-streaming"
      ? info.streaming
      : info.running;
  return detail ? { label: info.label, detail } : { label: info.label };
}

export function deriveAgentStatus(
  messages: UIMessage[],
  isLoading: boolean,
  autoFix?: AutoFixState | null,
): AgentStatus | null {
  if (!isLoading && !autoFix?.active) return null;

  if (autoFix?.active) {
    return {
      label: "Auto-fixing",
      detail: `attempt ${autoFix.attempts}/${autoFix.maxAttempts}`,
    };
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const parts = msg.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j] as {
        type: string;
        state?: string;
      };
      if (typeof part.type !== "string" || !part.type.startsWith("tool-")) {
        continue;
      }
      const state = part.state ?? "unknown";
      const isDone = state === "output-available" || state === "result";
      const isError = state === "output-error" || state === "error";
      if (isDone || isError) continue;

      const toolName = part.type.slice("tool-".length);
      return toolStatus(toolName, state);
    }
    break;
  }

  return { label: "Thinking" };
}

export function formatAgentStatus(status: AgentStatus): string {
  return status.detail ? `${status.label} · ${status.detail}…` : `${status.label}…`;
}
