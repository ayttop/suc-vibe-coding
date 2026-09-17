import { useCallback, useEffect, useRef, useState } from "react";
import { useHfAuth } from "./hooks/useHfAuth";
import { useVirtualFS } from "./hooks/useVirtualFS";
import { useAgentChat } from "./hooks/useAgentChat";
import { usePreviewDiagnostics } from "./hooks/usePreviewDiagnostics";
import { SignInScreen } from "./components/SignInScreen";
import { TopBar } from "./components/TopBar";
import { ChatPanel } from "./components/ChatPanel";
import { CodeEditor } from "./components/CodeEditor";
import { PreviewFrame } from "./components/PreviewFrame";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { PublishDialog } from "./components/PublishDialog";
import { KnowledgeDialog } from "./components/KnowledgeDialog";
import { deriveAgentStatus } from "./utils/agent-status";

interface Model {
  id: string;
  label: string;
}

type Tab = "code" | "preview";

export function App() {
  const auth = useHfAuth();
  const vfs = useVirtualFS();
  const diagnostics = usePreviewDiagnostics();

  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const modelRef = useRef<string | null>(selectedModel);
  modelRef.current = selectedModel;

  const [activeTab, setActiveTab] = useState<Tab>("preview");
  const [publishOpen, setPublishOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);

  const chat = useAgentChat({
    accessToken: auth.accessToken,
    vfs,
    modelRef,
    diagnostics,
    onShowPreview: () => setActiveTab("preview"),
  });

  // When the agent touches a file (write_file / edit_file / read_file
  // / delete_file), flip to the Code tab so the user sees what the
  // agent is doing. This covers both live streaming (write_file) and
  // atomic edits (edit_file). We don't auto-flip BACK to Preview at
  // the end - the agent does that explicitly via the `show_preview`
  // tool when it's done.
  const lastFocusedPathRef = useRef<string | null>(null);
  useEffect(() => {
    const focused = chat.focusedFilePath;
    if (focused && focused !== lastFocusedPathRef.current) {
      setActiveTab("code");
    }
    lastFocusedPathRef.current = focused;
  }, [chat.focusedFilePath]);

  const previewStatus = deriveAgentStatus(
    chat.messages,
    chat.isLoading,
    chat.autoFix ?? null,
  );

  useEffect(() => {
    if (!auth.isSignedIn || !auth.accessToken) return;
    let cancelled = false;
    fetch("/api/models", {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setModels(data.models ?? []);
        if (data.default && !selectedModel) setSelectedModel(data.default);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [auth.isSignedIn, auth.accessToken, selectedModel]);

  const handleReset = useCallback(() => {
    if (
      !confirm(
        "Clear the chat history and all files in the virtual FS? This cannot be undone.",
      )
    ) {
      return;
    }
    chat.clearMessages();
    vfs.clear();
  }, [chat, vfs]);

  const handleFileChange = useCallback(
    (path: string, content: string) => {
      vfs.writeFile(path, content);
    },
    [vfs],
  );

  if (!auth.isReady) {
    return (
      <div className="app-shell">
        <div style={{ margin: "auto", color: "var(--text-faint)" }}>
          Loading…
        </div>
      </div>
    );
  }

  if (!auth.isSignedIn) {
    return (
      <div className="app-shell">
        <SignInScreen
          onSignIn={auth.signIn}
          isSigningIn={auth.isSigningIn}
          error={auth.error}
          hasClientId={!!auth.clientId}
        />
      </div>
    );
  }

  // Publishing is gated on two things: (a) the agent must have produced
  // at least one file to publish, and (b) the agent must not be mid-turn,
  // otherwise we'd capture a half-written VFS snapshot.
  const publishDisabledReason: string | null =
    vfs.files.length === 0
      ? "Ask the agent to generate files first."
      : chat.isLoading
        ? "Wait for the agent to finish its turn."
        : null;

  return (
    <div className="app-shell">
      <TopBar
        user={auth.user}
        models={models}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        onPublish={() => setPublishOpen(true)}
        onSignOut={auth.signOut}
        onReset={handleReset}
        onOpenKnowledge={() => setKnowledgeOpen(true)}
        publishDisabledReason={publishDisabledReason}
      />

      <div className="app-main">
        <ChatPanel
          messages={chat.messages}
          isLoading={chat.isLoading}
          input={chat.input}
          setInput={chat.setInput}
          onSend={chat.sendMessage}
          onStop={chat.stop}
          error={chat.error ?? null}
          autoFix={chat.autoFix}
          iconPreviews={chat.iconPreviews}
        />

        <div className="right-pane">
          <div className="tab-bar">
            <button
              type="button"
              className={`tab ${activeTab === "code" ? "active" : ""} ${
                chat.streamingFiles.size > 0 ? "tab-streaming" : ""
              }`}
              onClick={() => setActiveTab("code")}
            >
              Code · {vfs.files.length}
              {chat.streamingFiles.size > 0 && (
                <span
                  className="tab-streaming-dot"
                  aria-label="writing"
                  title="Agent is writing a file"
                />
              )}
            </button>
            <button
              type="button"
              className={`tab ${activeTab === "preview" ? "active" : ""}`}
              onClick={() => setActiveTab("preview")}
            >
              Preview
            </button>
            <div className="tab-spacer" />
          </div>

          <div
            className={`pane-content ${activeTab === "code" ? "" : "hidden"}`}
          >
            <CodeEditor
              files={vfs.files}
              onChange={handleFileChange}
              streamingFiles={chat.streamingFiles}
              focusedFilePath={chat.focusedFilePath}
            />
          </div>
          <div
            className={`pane-content preview-pane ${activeTab === "preview" ? "" : "hidden"}`}
          >
            <div className="preview-pane-frame">
              <PreviewFrame
                files={vfs.files}
                version={vfs.version}
                accessToken={auth.accessToken}
                userName={auth.user?.preferred_username ?? null}
                onDocReady={diagnostics.setDocId}
                onCompileError={diagnostics.push}
              />
              {previewStatus && (
                <div className="preview-building" aria-live="polite">
                  <span className="preview-building-dot" />
                  <span className="preview-building-label">
                    {previewStatus.label}
                    {previewStatus.detail && (
                      <>
                        {" "}
                        <span className="preview-building-detail mono">
                          {previewStatus.detail}
                        </span>
                      </>
                    )}
                    …
                  </span>
                </div>
              )}
            </div>
            <DiagnosticsPanel
              entries={diagnostics.entries}
              onClear={diagnostics.clear}
            />
          </div>
        </div>
      </div>

      <PublishDialog
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        files={vfs.files}
        getLiveFiles={vfs.getAll}
        accessToken={auth.accessToken}
        defaultUsername={auth.user?.preferred_username ?? null}
      />

      <KnowledgeDialog
        open={knowledgeOpen}
        onClose={() => setKnowledgeOpen(false)}
      />
    </div>
  );
}
