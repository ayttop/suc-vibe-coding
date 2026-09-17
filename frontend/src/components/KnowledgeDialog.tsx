import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "reachy-vibe-knowledge";
const MAX_LEN = 20_000;

interface KnowledgeDialogProps {
  open: boolean;
  onClose: () => void;
}

export function loadKnowledge(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function KnowledgeDialog({ open, onClose }: KnowledgeDialogProps) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setText(loadKnowledge());
    setSaved(false);
    const t = window.setTimeout(() => textareaRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, [open]);

  const handleSave = () => {
    try {
      const trimmed = text.slice(0, MAX_LEN);
      localStorage.setItem(STORAGE_KEY, trimmed);
      setText(trimmed);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      console.error("[knowledge] save failed", err);
    }
  };

  const handleClear = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    setText("");
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  if (!open) return null;

  const charCount = text.length;
  const approxKb = (charCount / 1024).toFixed(1);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal knowledge-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2>App Knowledge</h2>
            <p className="modal-sub">
              Long-lived context the agent sees on every message. Use it for
              the project goal, constraints, tone, preferred libraries,
              API keys already in place, etc.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="modal-body">
          <textarea
            ref={textareaRef}
            className="knowledge-textarea"
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX_LEN))}
            placeholder={[
              "Example:",
              "- I'm building an accessibility demo for Reachy Mini.",
              "- Keep the UI high-contrast and screen-reader friendly.",
              "- All robot commands must be undoable from the UI.",
              "- Prefer plain DOM over frameworks.",
            ].join("\n")}
            rows={14}
          />
          <div className="knowledge-meta">
            <span>
              {charCount.toLocaleString()} chars · ~{approxKb} KB
            </span>
            <span className="text-faint">
              Stored locally in your browser, sent on every prompt.
            </span>
          </div>
        </div>

        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={handleClear}>
            Clear
          </button>
          <div className="spacer" />
          {saved && <span className="saved-pill">Saved</span>}
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSave}>
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
