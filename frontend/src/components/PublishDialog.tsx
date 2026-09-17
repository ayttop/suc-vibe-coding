import { useEffect, useState } from "react";
import type { VirtualFile } from "../hooks/useVirtualFS";
import { usePublish } from "../hooks/usePublish";

interface PublishDialogProps {
  open: boolean;
  onClose: () => void;
  /** Files listed in the dialog preview (from React state). */
  files: VirtualFile[];
  /**
   * Pulls the live VFS snapshot at click time. Avoids racing with an agent
   * turn that's still writing files when the user hits Publish.
   */
  getLiveFiles: () => VirtualFile[];
  accessToken: string | null;
  defaultUsername: string | null;
}

function suggestRepoName(username: string | null): string {
  const stamp = new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
  return `reachy-voice-${stamp}`;
}

export function PublishDialog({
  open,
  onClose,
  files,
  getLiveFiles,
  accessToken,
  defaultUsername,
}: PublishDialogProps) {
  const { status, steps, result, error, errorCode, publish, reset } =
    usePublish(accessToken);

  const [repoName, setRepoName] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");

  useEffect(() => {
    if (open) {
      setRepoName((prev) => prev || suggestRepoName(defaultUsername));
      if (status !== "idle") reset();
    }
  }, [open, defaultUsername, reset, status]);

  if (!open) return null;

  const handlePublish = () => {
    if (status === "publishing") return;
    const liveFiles = getLiveFiles();
    publish({
      repoName,
      isPrivate,
      overwrite,
      commitMessage: commitMessage.trim() || undefined,
      files: liveFiles,
    });
  };

  const handleClose = () => {
    if (status === "publishing") return;
    reset();
    onClose();
  };

  return (
    <div className="dialog-backdrop" onClick={handleClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header className="dialog-header">
          <span>Publish to Hugging Face Space</span>
          <button
            type="button"
            className="btn-ghost"
            onClick={handleClose}
            disabled={status === "publishing"}
            style={{ padding: "4px 8px" }}
          >
            ✕
          </button>
        </header>

        <div className="dialog-body">
          <div className="field">
            <label>Space name</label>
            <input
              type="text"
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
              placeholder="my-reachy-app"
              disabled={status === "publishing"}
            />
            {defaultUsername && (
              <div className="field-hint">
                Will be published as <code>{defaultUsername}/{repoName || "<name>"}</code>
              </div>
            )}
          </div>

          <div className="field">
            <label>Commit message (optional)</label>
            <input
              type="text"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Initial commit from Reachy Mini Vibe Coding Apps"
              disabled={status === "publishing"}
            />
          </div>

          <div className="field-row">
            <input
              id="publish-private"
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              disabled={status === "publishing"}
            />
            <label htmlFor="publish-private" style={{ cursor: "pointer" }}>
              Make Space private
            </label>
          </div>

          <div className="field-row">
            <input
              id="publish-overwrite"
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              disabled={status === "publishing"}
            />
            <label htmlFor="publish-overwrite" style={{ cursor: "pointer" }}>
              Overwrite if Space already exists
            </label>
          </div>

          <div className="field">
            <label>Files to upload ({files.length})</label>
            <div className="publish-log">
              {files.map((f) => (
                <div key={f.path} className="publish-log-step">
                  {f.path}{" "}
                  <span style={{ color: "var(--text-faint)" }}>
                    · {f.content.length}B ·{" "}
                    {new Date(f.updatedAt).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
            {files.length > 0 && (
              <div className="field-hint">
                Snapshot taken when clicking Publish. Timestamps confirm the
                latest agent edits are included.
              </div>
            )}
          </div>

          {steps.length > 0 && (
            <div className="field">
              <label>Progress</label>
              <div className="publish-log">
                {steps.map((s, i) => (
                  <div
                    key={i}
                    className={`publish-log-step ${s.step === "done" ? "done" : ""}`}
                  >
                    [{s.step}] {s.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          {status === "done" && result.spaceUrl && (
            <div className="publish-success">
              <div>✓ Published!</div>
              <div>
                <a href={result.spaceUrl} target="_blank" rel="noopener">
                  {result.spaceUrl}
                </a>
              </div>
            </div>
          )}

          {status === "error" && error && (
            <div className="publish-error">
              {error}
              {errorCode === "REPO_EXISTS" && (
                <div style={{ marginTop: 6 }}>
                  Enable "Overwrite if Space already exists" and try again.
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="dialog-footer">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleClose}
            disabled={status === "publishing"}
          >
            {status === "done" ? "Close" : "Cancel"}
          </button>
          {status !== "done" && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handlePublish}
              disabled={
                status === "publishing" ||
                repoName.trim().length === 0 ||
                files.length === 0
              }
            >
              {status === "publishing" ? "Publishing…" : "Publish"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
