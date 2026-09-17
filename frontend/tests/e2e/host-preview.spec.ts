import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPreviewDoc } from "../../src/components/PreviewFrame";

// Invariant locked (P2 unification): with the HF token seeded (as the real
// PreviewFrame does), a generated app's standalone `mountHost()` path
// authenticates from cache and renders the REAL host shell in the preview -
// NOT a sign-in screen and NOT the old bare app UI - even with no robot.

const CDN = "https://cdn.jsdelivr.net/npm/@pollen-robotics/reachy-mini-sdk@1.8.0";

// Minimal mirror of the template: process shim + #root + #app + main.js
// dispatch (mountHost when standalone, connectToHost when embedded).
const INDEX = `<!doctype html><html><head>
<script>globalThis.process=globalThis.process||{env:{}};globalThis.process.env=globalThis.process.env||{};globalThis.process.env.NODE_ENV=globalThis.process.env.NODE_ENV||"production";</script>
</head><body>
<div id="root"></div>
<main id="app" hidden><h1>BARE APP UI</h1></main>
<script src="./main.js"></script>
</body></html>`;

const MAIN_JS = `
const params = new URLSearchParams(location.search);
const isEmbed = params.get("embedded") === "1";
if (isEmbed) {
  const { connectToHost } = await import("${CDN}/host/dist/entry/embed.js");
  await connectToHost();
} else {
  const { mountHost } = await import("${CDN}/host/dist/entry/auto.js");
  mountHost({ appName: "Preview Test App", appEmoji: "🤖", enableMicrophone: false });
}
`;

test("seeded-token preview renders the host shell (authenticated, no robot), not sign-in", async ({
  page,
}) => {
  const doc = await buildPreviewDoc(
    [
      { path: "index.html", content: INDEX },
      { path: "main.js", content: MAIN_JS },
    ],
    "hf_fake_preview_token", // PreviewFrame seeds this into sessionStorage
    301,
    undefined,
    "tfrere",
  );
  const dir = mkdtempSync(join(tmpdir(), "reachy-host-preview-"));
  const file = join(dir, "preview.html");
  writeFileSync(file, doc ?? "");

  await page.addInitScript(() => {
    (window as unknown as { __msgs: unknown[] }).__msgs = [];
    window.addEventListener("message", (e) =>
      (window as unknown as { __msgs: unknown[] }).__msgs.push(e.data),
    );
  });
  await page.goto("file://" + file);

  // 1. The host shell mounted into #root (mountHost ran -> standalone path).
  await expect
    .poll(
      async () =>
        page.evaluate(
          () => document.getElementById("root")?.childElementCount ?? 0,
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  // 2. We end up PAST sign-in: the seeded token satisfies authenticate()
  //    (async, after mountHost mounts), so the shell leaves the sign-in
  //    view for the picker. Poll - it briefly shows sign-in before
  //    authenticate() resolves, which is expected, not a failure.
  await expect
    .poll(
      async () => {
        const t = (await page.textContent("body"))?.toLowerCase() ?? "";
        return (
          t.includes("continue with hugging face") ||
          t.includes("sign in to hugging face")
        );
      },
      { timeout: 15_000 },
    )
    .toBe(false);

  // 3. No false auto-fix: the reporter saw no actionable (severity:error)
  //    diagnostic - host/central noise is warn/info, not error.
  const errorMsgs = await page.evaluate(() =>
    ((window as unknown as { __msgs: any[] }).__msgs ?? []).filter(
      (m: any) => m?.severity === "error",
    ),
  );
  expect(errorMsgs).toEqual([]);
});
