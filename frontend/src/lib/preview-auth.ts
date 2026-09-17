// Seeding the HF session the vibe-coder already holds into the sandboxed
// preview so a generated app's mountHost()/connectToHost() authenticates
// from cache WITHOUT an interactive OAuth round-trip (which can't complete
// in a srcdoc iframe).
//
// SAFETY: these are the keys the Reachy Mini SDK / host shell read
// (reachy_mini/ts/host/src/lib/settings.ts). They are DISJOINT from the
// parent vibe-coder's own auth key ("hf-oauth-result-v1", see useHfAuth)
// and its localStorage key ("reachy-vibe-knowledge"), so seeding them in
// the same-origin srcdoc preview cannot corrupt the parent's session.
export const SDK_SESSION_TOKEN_KEY = "hf_token";
export const SDK_SESSION_USER_KEY = "hf_username";
export const SDK_SESSION_EXPIRES_KEY = "hf_token_expires";
export const SDK_SIGNED_OUT_KEY = "reachy_mini_signed_out";

// Mirrors the host's dev-token TTL (settings.ts TOKEN_TTL_MS).
const TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Build the `<head>` script that seeds the preview's auth. Returns "" when
 * there is no token (the generated app then shows its own sign-in, exactly
 * like a real standalone first load).
 *
 * It:
 *  - seeds `hf_token` / `hf_username` / `hf_token_expires` so the SDK's
 *    `authenticate()` resolves from cache (skips OAuth) -> the host shell
 *    goes straight to the robot picker;
 *  - clears the host's `reachy_mini_signed_out` flag so a prior in-preview
 *    sign-out doesn't suppress auto-auth on the next build;
 *  - also sets `window.__REACHY_MINI_PREVIEW_TOKEN__` for backward
 *    compatibility with apps published against the older template.
 */
export function buildPreviewAuthScript(
  accessToken: string | null | undefined,
  userName?: string | null,
): string {
  if (!accessToken) return "";
  const cfg = JSON.stringify({
    token: accessToken,
    userName: userName || "you",
    ttlMs: TOKEN_TTL_MS,
  });
  return `<script>(function(){try{
  var c = ${cfg};
  window.__REACHY_MINI_PREVIEW_TOKEN__ = c.token;
  sessionStorage.setItem(${JSON.stringify(SDK_SESSION_TOKEN_KEY)}, c.token);
  sessionStorage.setItem(${JSON.stringify(SDK_SESSION_USER_KEY)}, c.userName);
  sessionStorage.setItem(${JSON.stringify(SDK_SESSION_EXPIRES_KEY)}, new Date(Date.now() + c.ttlMs).toISOString());
  localStorage.removeItem(${JSON.stringify(SDK_SIGNED_OUT_KEY)});
}catch(_e){}})();</script>`;
}
