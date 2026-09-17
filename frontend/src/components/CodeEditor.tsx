import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { VirtualFile } from "../hooks/useVirtualFS";

type MonacoEditorInstance = Parameters<OnMount>[0];

interface CodeEditorProps {
  files: VirtualFile[];
  onChange: (path: string, content: string) => void;
  /**
   * Partial file contents streamed from the agent while a `write_file`
   * tool call is in flight (`input-streaming` state). Keys are file
   * paths, values are the growing partial content. Overlays take
   * precedence over `files` for display purposes only - they are NOT
   * written to the VFS (the preview stays stable until the tool
   * completes and the final content is committed).
   */
  streamingFiles?: Map<string, string>;
  /**
   * Path of the file the agent is currently attending to via any
   * file-scoped tool (write_file streaming, edit_file, read_file,
   * delete_file). When this changes, the editor auto-switches to
   * that tab so the user can see what the agent is doing - covers
   * atomic edits that don't stream content, which `streamingFiles`
   * alone would miss.
   */
  focusedFilePath?: string | null;
}

function guessLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "html":
      return "html";
    case "css":
      return "css";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    case "sh":
      return "shell";
    default:
      return "plaintext";
  }
}

interface DisplayFile {
  path: string;
  content: string;
  streaming: boolean;
}

export function CodeEditor({
  files,
  onChange,
  streamingFiles,
  focusedFilePath,
}: CodeEditorProps) {
  const [activePath, setActivePath] = useState<string | null>(null);
  // Remember the path the user manually picked so we don't rip focus
  // away from it on every render. Only auto-follow the agent's focus
  // when the user hasn't made a manual selection yet, OR when the
  // agent moves to a different file (that's the interesting signal:
  // "the agent just switched its attention, show me").
  const userPickedRef = useRef(false);
  const lastStreamingKeysRef = useRef<string>("");
  const lastFocusedPathRef = useRef<string | null>(null);

  // Build the merged file list: committed files + streaming overlays
  // that aren't yet in the VFS. Overlays override committed content
  // for the same path.
  const displayFiles: DisplayFile[] = useMemo(() => {
    const byPath = new Map<string, DisplayFile>();
    for (const f of files) {
      byPath.set(f.path, { path: f.path, content: f.content, streaming: false });
    }
    if (streamingFiles) {
      for (const [path, content] of streamingFiles) {
        byPath.set(path, { path, content, streaming: true });
      }
    }
    return Array.from(byPath.values()).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
  }, [files, streamingFiles]);

  // Auto-follow logic.
  //
  // Priority order:
  //   1. A file is actively streaming (`write_file` in flight) - always
  //      win, that's the most time-sensitive signal.
  //   2. The agent just focused a different file via a non-streaming
  //      tool (`edit_file`, `read_file`, `delete_file`) - switch so
  //      the user sees the edit happen / knows what the agent read.
  //   3. Otherwise, respect the user's manual selection or pick a
  //      sensible default when nothing is active.
  useEffect(() => {
    const streamingPaths = streamingFiles ? [...streamingFiles.keys()] : [];
    const key = streamingPaths.sort().join("|");
    const streamingStarted =
      streamingPaths.length > 0 && key !== lastStreamingKeysRef.current;
    lastStreamingKeysRef.current = key;

    if (streamingPaths.length > 0) {
      const target = streamingPaths[0];
      if (activePath !== target && (streamingStarted || !userPickedRef.current)) {
        setActivePath(target);
        userPickedRef.current = false;
      }
      // Keep the focused-path ref in sync so we don't re-trigger when
      // streaming ends and the same path stays "focused".
      lastFocusedPathRef.current = focusedFilePath ?? null;
      return;
    }

    // No streaming. Did the agent just focus a new file?
    const focusChanged =
      focusedFilePath != null && focusedFilePath !== lastFocusedPathRef.current;
    lastFocusedPathRef.current = focusedFilePath ?? null;

    if (
      focusChanged &&
      focusedFilePath &&
      displayFiles.some((f) => f.path === focusedFilePath) &&
      activePath !== focusedFilePath
    ) {
      setActivePath(focusedFilePath);
      // Agent-driven focus overrides any prior manual pick.
      userPickedRef.current = false;
      return;
    }

    // Fallback: default selection + recovery.
    if (!activePath && displayFiles.length > 0) {
      const preferred = displayFiles.find(
        (f) => f.path === "index.html" || f.path === "main.js",
      );
      setActivePath(preferred?.path ?? displayFiles[0].path);
      return;
    }
    if (activePath && !displayFiles.some((f) => f.path === activePath)) {
      setActivePath(displayFiles[0]?.path ?? null);
    }
  }, [displayFiles, activePath, streamingFiles, focusedFilePath]);

  const activeFile = useMemo(
    () => displayFiles.find((f) => f.path === activePath) ?? null,
    [displayFiles, activePath],
  );

  // Auto-scroll Monaco to the tail of the streaming content so new
  // lines appear at the bottom as they arrive, mimicking a terminal
  // "tail -f". When the user scrolls up manually, `revealLine` would
  // fight them - we only auto-reveal while the file is streaming.
  const monacoRef = useRef<MonacoEditorInstance | null>(null);
  const handleMount: OnMount = (editor) => {
    monacoRef.current = editor;
  };
  useEffect(() => {
    if (!activeFile?.streaming) return;
    const editor = monacoRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const lastLine = model.getLineCount();
    // `revealLine` with the `Smooth` scroll type is cheap (no-op when
    // already at the bottom) and doesn't move the cursor.
    editor.revealLine(lastLine);
  }, [activeFile?.content, activeFile?.streaming]);

  if (displayFiles.length === 0) {
    return (
      <div className="code-layout">
        <div className="file-tree">
          <div className="file-tree-empty">No files yet.</div>
        </div>
        <div className="editor-area">
          <div className="editor-placeholder">
            The agent will write files here. Ask it to create an app.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="code-layout">
      <div className="file-tree">
        {displayFiles.map((f) => (
          <div
            key={f.path}
            className={`file-tree-item ${activePath === f.path ? "active" : ""} ${
              f.streaming ? "streaming" : ""
            }`}
            onClick={() => {
              setActivePath(f.path);
              userPickedRef.current = true;
            }}
          >
            <span className="file-tree-path">
              {f.streaming && (
                <span className="file-tree-spinner" aria-hidden="true" />
              )}
              {f.path}
            </span>
            <span className="file-tree-size">
              {f.content.length.toLocaleString()}
              {f.streaming ? "…" : "B"}
            </span>
          </div>
        ))}
      </div>
      <div className="editor-area">
        {activeFile ? (
          <Editor
            key={activeFile.path}
            height="100%"
            theme="vs-dark"
            language={guessLanguage(activeFile.path)}
            value={activeFile.content}
            onChange={(v) => {
              if (activeFile.streaming) return;
              onChange(activeFile.path, v ?? "");
            }}
            onMount={handleMount}
            options={{
              fontSize: 12,
              fontFamily:
                '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              tabSize: 2,
              wordWrap: "on",
              automaticLayout: true,
              readOnly: activeFile.streaming,
            }}
          />
        ) : (
          <div className="editor-placeholder">Select a file from the tree.</div>
        )}
      </div>
    </div>
  );
}
