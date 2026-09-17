import { test, expect } from "@playwright/test";

/**
 * Regression: "clicking in the preview -> Failed to construct 'URL': Invalid
 * base URL -> black screen".
 *
 * Root cause: the Reachy host shell builds the embed iframe URL with
 * `new URL(embedPath, window.location.origin)` (ReachyHostShell.tsx). When the
 * preview was rendered via `srcdoc`, the document had an OPAQUE origin, so
 * `window.location.origin` serialised to the string "null" - an invalid base -
 * and that `new URL(...)` threw the moment a robot was picked.
 *
 * Fix: `PreviewFrame` loads the preview from a same-origin `blob:` URL, which
 * inherits the parent's real origin, so `location.origin` is a valid absolute
 * origin and the host's URL construction succeeds.
 *
 * This test locks BOTH sides of the contract:
 *   - the OLD `srcdoc` path reproduces the crash (origin "null", URL throws);
 *   - the NEW `blob:` path (what PreviewFrame now does) has a real origin and
 *     the exact host call `new URL("/?embedded=1", location.origin)` succeeds.
 */

// A minimal document that runs the EXACT primitive the host shell runs when a
// robot is selected: `new URL(embedPath, location.origin)`.
const DOC = `<!doctype html><html><head></head><body>
<script>
  var out = { origin: null, hostUrlThrew: null };
  try { out.origin = String(location.origin); } catch (e) { out.origin = "THREW"; }
  try {
    // Mirrors ReachyHostShell: new URL(embedPath, window.location.origin)
    new URL("/?embedded=1", location.origin);
    out.hostUrlThrew = false;
  } catch (e) {
    out.hostUrlThrew = String(e && e.message || e);
  }
  window.__probe = out;
</script>
</body></html>`;

async function readFrameProbe(page: import("@playwright/test").Page) {
  const frame = page.frames().find((f) => f !== page.mainFrame());
  expect(frame, "preview iframe frame should exist").toBeTruthy();
  return frame!.evaluate(() => (window as any).__probe as { origin: string; hostUrlThrew: string | false });
}

test.describe("preview URL base crash", () => {
  test.beforeEach(async ({ page }) => {
    // Give the parent a concrete http origin (blob URLs inherit it).
    await page.route("**/parent", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body>parent</body></html>",
      }),
    );
    await page.goto("http://localhost/parent");
  });

  test("srcdoc reproduces the crash (origin null, host URL throws)", async ({ page }) => {
    await page.evaluate((doc) => {
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-scripts allow-same-origin");
      f.srcdoc = doc;
      document.body.appendChild(f);
    }, DOC);
    await page.waitForTimeout(300);
    const probe = await readFrameProbe(page);
    expect(probe.origin).toBe("null");
    expect(probe.hostUrlThrew).toContain("Invalid base URL");
  });

  test("blob URL (the fix) has a real origin and host URL construction succeeds", async ({ page }) => {
    await page.evaluate(async (doc) => {
      const url = URL.createObjectURL(new Blob([doc], { type: "text/html" }));
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-scripts allow-same-origin");
      f.src = url;
      document.body.appendChild(f);
      await new Promise((res) => {
        f.onload = () => res(null);
        setTimeout(res, 1000);
      });
    }, DOC);
    const probe = await readFrameProbe(page);
    expect(probe.origin).not.toBe("null");
    expect(probe.origin).toBe("http://localhost");
    expect(probe.hostUrlThrew).toBe(false);
  });
});
