import { useState } from "react";
import type { Diagnostic } from "../hooks/usePreviewDiagnostics";

interface DiagnosticsPanelProps {
  entries: Diagnostic[];
  onClear: () => void;
}

function locLabel(d: Diagnostic): string {
  if (!d.file) return "";
  const parts = [d.file];
  if (d.line) parts.push(String(d.line));
  if (d.col) parts.push(String(d.col));
  return parts.join(":");
}

function kindLabel(kind: Diagnostic["kind"]): string {
  switch (kind) {
    case "compile-error":
      return "compile";
    case "unhandledrejection":
      return "promise";
    case "console.error":
      return "console";
    case "ready":
      return "ready";
    default:
      return "error";
  }
}

/**
 * Collapsible drawer shown under the preview iframe.
 *
 * Lists every runtime/compile error captured by `usePreviewDiagnostics`,
 * newest first. The user can clear the list at any time; the auto-fix
 * loop reads the same data separately, so clearing here doesn't affect
 * an attempt already in flight.
 */
export function DiagnosticsPanel({ entries, onClear }: DiagnosticsPanelProps) {
  const [open, setOpen] = useState(false);

  const actionableCount = entries.filter((e) => e.kind !== "ready").length;

  return (
    <div className="diagnostics-panel">
      <div
        className="diagnostics-header"
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <span className="diagnostics-header-left">
          <span>{open ? "▾" : "▸"} Diagnostics</span>
          <span
            className={`diagnostics-count ${actionableCount === 0 ? "zero" : ""}`}
          >
            {actionableCount}
          </span>
        </span>
        {actionableCount > 0 && (
          <button
            type="button"
            className="diagnostics-clear"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
          >
            Clear
          </button>
        )}
      </div>

      {open && (
        <div className="diagnostics-list">
          {entries.length === 0 ? (
            <div className="diagnostics-empty">No errors captured.</div>
          ) : (
            entries.map((d, i) => (
              <div
                key={`${d.timestamp}-${i}`}
                className={`diagnostic-row kind-${d.kind}`}
              >
                <span className="diagnostic-kind">{kindLabel(d.kind)}</span>
                <span className="diagnostic-message">{d.message}</span>
                {d.count && d.count > 1 && (
                  <span
                    className="diagnostic-count"
                    title={`Fired ${d.count} times`}
                  >
                    ×{d.count}
                  </span>
                )}
                <span className="diagnostic-loc">{locLabel(d)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
