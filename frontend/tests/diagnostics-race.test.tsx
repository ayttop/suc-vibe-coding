import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePreviewDiagnostics } from "../src/hooks/usePreviewDiagnostics";

// Invariant locked (Bug 3, the write-ordering RACE): when the agent writes
// index.html first (main.js still absent), build #1 emits a "Missing script
// ./main.js" compile-error. As soon as a later build (#2) resolves that
// reference and the app boots, that stale artifact must NOT keep the
// auto-fix loop alive. This test is RED before the docId-invalidation fix
// and GREEN after.

function bootedEvent(docId: number): MessageEvent {
  return {
    data: { source: "reachy-preview", kind: "booted", docId },
  } as unknown as MessageEvent;
}

describe("usePreviewDiagnostics - stale missing-asset race", () => {
  it("keeps the missing-asset error actionable within its own build", () => {
    const { result } = renderHook(() => usePreviewDiagnostics());
    act(() => {
      result.current.setDocId(1);
      result.current.push({
        docId: 1,
        kind: "compile-error",
        message: "Missing script in virtual FS: ./main.js",
        file: "./main.js",
        line: 1,
        timestamp: Date.now(),
      });
    });
    // Within build #1 (main.js genuinely absent) this IS a real, current
    // defect worth surfacing.
    expect(result.current.actionable).toHaveLength(1);
  });

  it("drops the stale missing-asset once a newer build resolves it and boots", () => {
    const { result } = renderHook(() => usePreviewDiagnostics());

    // Build #1: index.html present, main.js absent -> missing-asset error.
    act(() => {
      result.current.setDocId(1);
      result.current.push({
        docId: 1,
        kind: "compile-error",
        message: "Missing script in virtual FS: ./main.js",
        file: "./main.js",
        line: 1,
        timestamp: Date.now(),
      });
    });
    expect(result.current.actionable).toHaveLength(1);

    // Build #2: agent has now written main.js; the reference resolves (no new
    // compile-error) and the app boots.
    act(() => {
      result.current.setDocId(2);
      result.current.pushFromIframe(bootedEvent(2));
    });

    expect(result.current.booted).toBe(true);
    // The stale artifact from build #1 must no longer drive an auto-fix.
    expect(result.current.actionable).toHaveLength(0);
  });
});
