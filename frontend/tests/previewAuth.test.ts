import { describe, it, expect } from "vitest";
import {
  buildPreviewAuthScript,
  SDK_SESSION_TOKEN_KEY,
  SDK_SESSION_USER_KEY,
  SDK_SESSION_EXPIRES_KEY,
  SDK_SIGNED_OUT_KEY,
} from "../src/lib/preview-auth";

// Invariant locked: the preview seeds the token the vibe-coder already holds
// into the EXACT SDK storage keys, so a generated app's mountHost()
// authenticates from cache (no OAuth) and renders the host. If a key name
// drifts from the SDK contract (settings.ts), this test fails - which is the
// whole point, because the host would silently fall back to sign-in.

describe("buildPreviewAuthScript - preview auth seeding", () => {
  it("emits nothing when there is no token (app shows its own sign-in)", () => {
    expect(buildPreviewAuthScript(null)).toBe("");
    expect(buildPreviewAuthScript(undefined, "someone")).toBe("");
    expect(buildPreviewAuthScript("")).toBe("");
  });

  it("seeds the three SDK sessionStorage keys the host reads on authenticate()", () => {
    const script = buildPreviewAuthScript("hf_tok_123", "tfrere");
    // Writes to the exact keys reachy_mini/ts/host/src/lib/settings.ts reads.
    expect(script).toContain(`sessionStorage.setItem("${SDK_SESSION_TOKEN_KEY}"`);
    expect(script).toContain(`sessionStorage.setItem("${SDK_SESSION_USER_KEY}"`);
    expect(script).toContain(
      `sessionStorage.setItem("${SDK_SESSION_EXPIRES_KEY}"`,
    );
    // Regression guard: the keys must be the SDK's, not the parent's.
    expect(SDK_SESSION_TOKEN_KEY).toBe("hf_token");
    expect(script).not.toContain("hf-oauth-result-v1"); // parent's key - must not touch it
    // Carries the actual token + username.
    expect(script).toContain("hf_tok_123");
    expect(script).toContain("tfrere");
  });

  it("clears the host 'signed out' flag so a prior in-preview logout doesn't block auto-auth", () => {
    const script = buildPreviewAuthScript("hf_tok_123", "tfrere");
    expect(script).toContain(`localStorage.removeItem("${SDK_SIGNED_OUT_KEY}")`);
    expect(SDK_SIGNED_OUT_KEY).toBe("reachy_mini_signed_out");
  });

  it("falls back to a placeholder username when none is provided (authenticate needs all 3 keys present)", () => {
    const script = buildPreviewAuthScript("hf_tok_123", null);
    expect(script).toContain(`sessionStorage.setItem("${SDK_SESSION_USER_KEY}"`);
    expect(script).toContain('"you"');
  });

  it("keeps the legacy global for apps published against the old template", () => {
    const script = buildPreviewAuthScript("hf_tok_123", "tfrere");
    expect(script).toContain("window.__REACHY_MINI_PREVIEW_TOKEN__");
  });
});
