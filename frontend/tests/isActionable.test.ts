import { describe, it, expect } from "vitest";
import {
  isActionable,
  isMissingAssetError,
  type Diagnostic,
} from "../src/hooks/usePreviewDiagnostics";

// Invariant locked: auto-fix fires ONLY on a genuine current code-level
// defect - never on environmental/preview noise. `isActionable` is the
// decision boundary, so every realistic diagnostic must land on the right
// side of it.

function diag(p: Partial<Diagnostic>): Diagnostic {
  return {
    docId: 1,
    kind: "error",
    message: "",
    timestamp: 0,
    ...p,
  };
}

describe("isActionable - actionability decision boundary", () => {
  it("treats own-code runtime errors as actionable (real defects)", () => {
    // A ReferenceError/syntax error in the generated main.js is exactly what
    // the auto-fix loop exists to catch.
    expect(
      isActionable(
        diag({
          kind: "error",
          severity: "error",
          origin: "own-code",
          message: "ReferenceError: setHedRpyDeg is not defined",
          file: "main.js",
          line: 42,
        }),
      ),
    ).toBe(true);
    expect(
      isActionable(diag({ kind: "compile-error", message: "Unexpected token" })),
    ).toBe(true);
  });

  it("never actions logs / lifecycle signals", () => {
    expect(isActionable(diag({ kind: "ready" }))).toBe(false);
    expect(isActionable(diag({ kind: "booted" }))).toBe(false);
    expect(
      isActionable(
        diag({ kind: "console.warn", severity: "log", message: "heads up" }),
      ),
    ).toBe(false);
    // Even an "error"-kind entry tagged severity log is a log.
    expect(
      isActionable(diag({ kind: "error", severity: "log", message: "x" })),
    ).toBe(false);
  });

  it("never actions SDK/CDN-origin errors (not the app's bug)", () => {
    expect(
      isActionable(
        diag({
          kind: "error",
          severity: "error",
          origin: "sdk-cdn",
          message: "TypeError deep inside reachy-mini-sdk",
        }),
      ),
    ).toBe(false);
    expect(
      isActionable(
        diag({
          kind: "console.error",
          severity: "error",
          origin: "sdk-cdn",
          message: "WebRTC negotiation blew up",
        }),
      ),
    ).toBe(false);
  });

  it("falls back to the legacy allow-list ONLY for origin=unknown", () => {
    // Environmental noise surfaced without a resolvable origin: no robot,
    // failed session, SDK-tagged messages -> not actionable.
    for (const message of [
      "No robot online",
      "Failed to start session: robot_busy",
      "[reachy-mini] ice connection failed",
      "not authenticated",
      "HTTP 401",
    ]) {
      expect(
        isActionable(diag({ kind: "error", origin: "unknown", message })),
      ).toBe(false);
    }
    // A genuine-looking error with no origin and NOT in the allow-list stays
    // actionable (we must not silently swallow real errors).
    expect(
      isActionable(
        diag({
          kind: "error",
          origin: "unknown",
          message: "TypeError: cannot read properties of null (reading 'x')",
        }),
      ),
    ).toBe(true);
  });

  it("actions Temporal-Dead-Zone ReferenceErrors from the app (real defect)", () => {
    // "Cannot access 'X' before initialization" is a genuine own-code bug (a
    // const/let referenced before its declaration). It must trigger auto-fix
    // whether the reporter tagged it own-code (structural) OR left it unknown
    // (e.g. a blob: filename that slipped past classifyOrigin) - it is not in
    // the environmental allow-list.
    for (const origin of ["own-code", "unknown"] as const) {
      expect(
        isActionable(
          diag({
            kind: "error",
            severity: "error",
            origin,
            message:
              "ReferenceError: Cannot access 'targetPose' before initialization",
            file: "main.js",
          }),
        ),
      ).toBe(true);
    }
  });

  it("recognises the missing-local-asset build artifact", () => {
    expect(
      isMissingAssetError(
        diag({
          kind: "compile-error",
          message: "Missing script in virtual FS: ./main.js",
        }),
      ),
    ).toBe(true);
    expect(
      isMissingAssetError(
        diag({ kind: "error", message: "Missing script in virtual FS: x" }),
      ),
    ).toBe(false); // only compile-errors
  });
});
