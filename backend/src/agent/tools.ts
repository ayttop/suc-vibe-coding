import { tool } from "ai";
import { z } from "zod";
import { getPrimarySkill, getSkillDoc, listSkillDocs } from "./skill-loader.js";

/**
 * ## Editor tools
 *
 * These tools describe *intents* to the LLM but are **executed client-side**:
 * the Vercel AI SDK streams the tool call to the browser, the React app
 * mutates the virtual FS, then sends the tool result back. This mirrors the
 * pattern from `collab-editor` and keeps the backend completely stateless.
 *
 * ## Skill tools
 *
 * `read_skill_doc` is executed **server-side** (we have the files on disk)
 * and returns markdown content directly in the tool result.
 */

const editorTools = {
  write_file: tool({
    description:
      "Create a new file or fully overwrite an existing one in the virtual " +
      "file system. Use when introducing a brand-new file or when a full " +
      "rewrite is cleaner than a targeted edit. The UI will update its file " +
      "tree and preview immediately.",
    inputSchema: z.object({
      path: z
        .string()
        .describe(
          "Relative POSIX path inside the virtual project (e.g. " +
            "`src/main.ts`, `index.html`, `Dockerfile`). No leading slash.",
        ),
      content: z
        .string()
        .describe("Full file contents. UTF-8 text."),
    }),
  }),

  edit_file: tool({
    description:
      "Replace an exact substring inside an existing file. Preferred for " +
      "small, surgical edits - much cheaper than rewriting the whole file. " +
      "`old_string` must appear EXACTLY ONCE in the target file (add " +
      "surrounding context if needed).",
    inputSchema: z.object({
      path: z.string().describe("Path of the file to edit."),
      old_string: z
        .string()
        .describe(
          "Exact text to find (must be unique in the file, include context " +
            "lines before/after if ambiguous).",
        ),
      new_string: z.string().describe("Text to replace `old_string` with."),
    }),
  }),

  delete_file: tool({
    description: "Delete a file from the virtual FS.",
    inputSchema: z.object({
      path: z.string(),
    }),
  }),

  read_file: tool({
    description:
      "Read the current contents of a file in the virtual FS. Use before " +
      "`edit_file` when you are not sure of the exact current text.",
    inputSchema: z.object({
      path: z.string(),
    }),
  }),

  list_files: tool({
    description:
      "List all files currently in the virtual FS with their size in bytes.",
    inputSchema: z.object({}),
  }),

  read_console_logs: tool({
    description:
      "Read the most recent runtime/compile errors and warnings captured " +
      "from the preview iframe. Call this FIRST when debugging a user " +
      "report like \"it doesn't work\" - the concrete JS/TS errors are " +
      "often enough to pinpoint the fix without re-reading the code. " +
      "Returns a formatted list of diagnostics; returns \"(no diagnostics)\" " +
      "if the preview is clean.",
    inputSchema: z.object({
      limit: z
        .number()
        .optional()
        .describe("Maximum number of entries to return (default 20)."),
    }),
  }),

  generate_app_icon: tool({
    description:
      "Generate a dedicated, transparent Reachy sticker as the app's " +
      "`icon.svg` (via the Reachy Sticker Generator). Executed client-side: " +
      "it starts the job, BLOCKS while polling to completion (~60s, up to a " +
      "2min timeout), then writes the result to `icon.svg` in the virtual FS " +
      "(overwriting any previous one) so it shows in the preview top bar and " +
      "is committed on publish. Re-runnable: call again to regenerate. On " +
      "timeout/quota/failure it does NOT fail the build - it keeps the default " +
      "\"reachy simple\" icon and reports why. Derive a short, vivid `prompt` " +
      "from the app's theme/name (e.g. \"a cheerful Reachy Mini robot playing " +
      "a joystick game\"), or use the user's explicit wording when given. " +
      "Call it once the app concept is clear (or when the user asks for an " +
      "icon); it is optional - skip it if the user doesn't want a custom icon.",
    inputSchema: z.object({
      prompt: z
        .string()
        .describe(
          "Short vivid description of the icon subject, Reachy-themed. " +
            "Derived from the app or given by the user. The generator draws a " +
            "single transparent sticker; no need to mention 'svg' or 'sticker'.",
        ),
    }),
  }),

  show_preview: tool({
    description:
      "Switch the right pane from Code to Preview so the user can see " +
      "the running app. Call this as the **last action of your turn** " +
      "once all files are written and the app should be ready to test. " +
      "Takes no arguments. Don't call this mid-turn (the user will be " +
      "yanked away from the code they're reading). Don't call it when " +
      "you know the app will crash (e.g. you intentionally left something " +
      "broken for the next turn) - leave the user on the Code tab so " +
      "they see the issue.",
    inputSchema: z.object({}),
  }),
};

const skillTools = {
  read_skill_doc: tool({
    description:
      "Read a detailed robot-knowledge chapter from the embedded " +
      "`reachy-mini-app` skill. Call this BEFORE writing non-trivial " +
      "code. Available chapters (concept-level, apply to any static " +
      "demo): robot-overview (DOF, safety, motors, must-know rules), " +
      "robot-motion (goto vs setTarget), robot-interaction " +
      "(antennas-as-buttons, head-as-joystick, no-GUI patterns), " +
      "robot-rest-api (daemon HTTP + WebSocket endpoints). Start with " +
      "`robot-overview` the first time you touch a new project. " +
      "The app template itself is already inlined in the system prompt " +
      "(the skill hub) - no need to fetch it separately. " +
      "Returns the full markdown of the requested chapter.",
    inputSchema: z.object({
      topic: z
        .string()
        .describe(
          "Chapter name without extension. Available topics: " +
            "robot-overview, robot-motion, robot-interaction, " +
            "robot-rest-api.",
        ),
    }),
    execute: async ({ topic }) => {
      const skill = getPrimarySkill();
      if (!skill) {
        return "ERROR: No skill is loaded on the server.";
      }
      const doc = getSkillDoc(skill, topic);
      if (!doc) {
        const available = listSkillDocs(skill).join(", ");
        return `ERROR: No such skill chapter "${topic}". Available: ${available}`;
      }
      return doc.content;
    },
  }),
};

export const agentTools = {
  ...editorTools,
  ...skillTools,
};

export const TOOL_NAMES = Object.keys(agentTools) as (keyof typeof agentTools)[];
