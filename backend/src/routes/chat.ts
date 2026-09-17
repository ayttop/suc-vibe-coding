import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamText, convertToModelMessages, stepCountIs } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { agentTools } from "../agent/tools.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import { rateLimit } from "../rate-limit.js";
import type { AppBindings } from "../types.js";

interface ContextFile {
  path: string;
  size: number;
  content?: string;
}

const MAX_KNOWLEDGE_LEN = 20_000;
const USEFUL_CONTEXT_TOTAL_CAP = 48_000;

function buildUsefulContext(files: ContextFile[] | undefined): string {
  if (!files || files.length === 0) {
    return "\n\n## Current virtual FS\n\n*(empty - nothing has been written yet)*\n";
  }

  const header = files
    .map((f) => {
      const flag = f.content ? "inlined below" : "large, use read_file";
      return `- \`${f.path}\` (${f.size} bytes, ${flag})`;
    })
    .join("\n");

  const inlined: string[] = [];
  let remaining = USEFUL_CONTEXT_TOTAL_CAP;
  for (const f of files) {
    if (!f.content) continue;
    if (f.content.length > remaining) continue;
    remaining -= f.content.length;
    const lang = inferLang(f.path);
    inlined.push(
      `### \`${f.path}\`\n\n\`\`\`${lang}\n${f.content}\n\`\`\``,
    );
  }

  const contents = inlined.length
    ? `\n\n## useful-context (files already inlined)\n\nThe files below are the **current** contents of the virtual FS. Do **not** call \`read_file\` on any of them - you already have them here. Call \`read_file\` only for files flagged "large, use read_file" above.\n\n${inlined.join(
        "\n\n",
      )}`
    : "";

  return `\n\n## Current virtual FS\n\n${header}${contents}\n`;
}

function buildKnowledgeBlock(knowledge: string | undefined): string {
  if (!knowledge) return "";
  const trimmed = knowledge.trim().slice(0, MAX_KNOWLEDGE_LEN);
  if (!trimmed) return "";
  return `\n\n## app-knowledge (persistent user-provided context)\n\nThe user has pinned the following context. Treat it as background knowledge that applies to every turn unless contradicted by a newer instruction.\n\n${trimmed}\n`;
}

function inferLang(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    html: "html",
    htm: "html",
    css: "css",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "jsx",
    ts: "typescript",
    tsx: "tsx",
    json: "json",
    md: "markdown",
    py: "python",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    sh: "bash",
  };
  return map[ext] ?? "";
}

export const DEFAULT_MODEL = process.env.MODEL || "Qwen3.8-27B-64k:latest";

export const AVAILABLE_MODELS = [
  { id: DEFAULT_MODEL, label: "Local Ollama Model", context: "64K", cost: "Free" },
];

/**
 * Hard cap on consecutive tool-call rounds - prevents runaway loops when a
 * model keeps calling tools instead of emitting a final text response.
 */
const MAX_STEPS = 16;

/**
 * Request-body cap. Typical /api/chat bodies are 50-100KB (messages +
 * inlined virtual-FS context + knowledge). 200KB gives comfortable margin
 * without letting a malicious caller blow up memory.
 */
const MAX_BODY_BYTES = 200_000;

/**
 * Per-user rate limit. A single agent turn can translate to up to
 * MAX_TOOL_ROUNDS (12) calls to /api/chat because the SDK re-posts the
 * conversation after each tool round. Auto-fix can trigger another 3
 * turns. 60/min covers even the most aggressive legit use while still
 * capping abuse.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

/**
 * Stream timeout. Caps how long a single /api/chat request can occupy
 * the event loop waiting on OpenRouter. Long Claude thinking + multi-tool
 * turns rarely exceed 60s; 120s is safe.
 */
const STREAM_TIMEOUT_MS = 120_000;

export const chatRoute = new Hono<AppBindings>();

chatRoute.use(
  "/*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json(
        {
          error: `Request body too large (max ${MAX_BODY_BYTES} bytes).`,
        },
        413,
      ),
  }),
);

chatRoute.use(
  "/*",
  rateLimit({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX }),
);

chatRoute.post("/", async (c) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // 503 (not 500) so upstream monitors / clients understand this is a
    // config issue, not a bug: the service is healthy but an external
    // dependency (the API key Space secret) is missing.
    return c.json(
      {
        error:
          "Service temporarily unavailable: missing OPENROUTER_API_KEY. " +
          "Check the Space's Variables and secrets settings.",
      },
      503,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { messages, model, context, knowledge } = (body ?? {}) as {
    messages?: unknown;
    model?: string;
    context?: { files?: ContextFile[] };
    knowledge?: string;
  };

  if (!Array.isArray(messages)) {
    return c.json({ error: "`messages` array is required" }, 400);
  }
  const baseURL = process.env.OPENAI_BASE_URL || "http://localhost:11434/v1";
  const provider = createOpenRouter({ apiKey, baseURL });
  const modelId = process.env.MODEL || model || DEFAULT_MODEL;

  const systemPrompt = buildSystemPrompt();
  const knowledgeBlock = buildKnowledgeBlock(knowledge);
  const contextBlock = buildUsefulContext(context?.files);
  const tools = agentTools;

  const modelMessages = await convertToModelMessages(messages as never);

  // Abort the stream if OpenRouter stalls. The `abortSignal` is also
  // merged with the incoming request's signal (if the client disconnects)
  // so we don't keep pumping tokens into a dead socket.
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort(
      new Error(`Stream timed out after ${STREAM_TIMEOUT_MS}ms`),
    );
  }, STREAM_TIMEOUT_MS);

  const clientSignal = c.req.raw.signal;
  const onClientAbort = () => timeoutController.abort(clientSignal.reason);
  if (clientSignal.aborted) onClientAbort();
  else clientSignal.addEventListener("abort", onClientAbort, { once: true });

  const cleanup = () => {
    clearTimeout(timeoutId);
    clientSignal.removeEventListener("abort", onClientAbort);
  };

  try {
    const result = streamText({
      model: provider.chat(modelId),
      system: systemPrompt + knowledgeBlock + contextBlock,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: timeoutController.signal,
      onFinish: cleanup,
      onError: ({ error }) => {
        cleanup();
        console.error("[chat] stream error:", error);
      },
    });

    const response = result.toUIMessageStreamResponse({
      onError: (error) => {
        console.error("[chat] stream error:", error);
        return error instanceof Error ? error.message : "Stream error";
      },
    });

    return response;
  } catch (error) {
    cleanup();
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[chat] error:", message);
    return c.json({ error: message }, 500);
  }
});

