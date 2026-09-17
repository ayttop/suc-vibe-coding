import { test, expect } from "@playwright/test";

/**
 * Black-screen v2 regression: in embed mode the app UI is present in the DOM
 * (#app revealed + filled) yet the screen is BLACK.
 *
 * Mechanism (measured below): the template ships BOTH `<div id="root">` (the
 * standalone mountHost target) and `<main id="app">` (the embed UI). In embed
 * mode mountHost never runs, so `#root` stays EMPTY - but the generated CSS
 * commonly styles it as a full-screen dark mount container
 * (`#root{position:fixed;inset:0;background:#…}`). A positioned element paints
 * ABOVE its static siblings, so the empty, dark, fixed `#root` covers the
 * static `#app` even though `#app` comes later in the DOM. Result:
 * `elementFromPoint(center)` is `#root`, not the app UI → black screen.
 *
 * Fix (corrected contract): each mode keeps only ITS surface - the embed branch
 * removes `#root` (unused in embed) before revealing `#app`. Then `#app` is the
 * top element at the center and the UI is actually visible.
 */

// Mirrors the real embed doc: #root (empty in embed) styled full-screen dark,
// #app carrying the app UI. `removeRoot` reflects the corrected template.
function embedDoc(opts: { removeRoot: boolean }): string {
  const removeLine = opts.removeRoot
    ? `document.getElementById("root")?.remove();`
    : `/* buggy: leaves empty #root overlaying #app */`;
  return `<!doctype html><html><head><style>
    html,body{height:100%;margin:0}
    /* Agent-typical: style the mount container as a full-screen dark surface. */
    #root{position:fixed;inset:0;background:#0b0b0d;z-index:0}
    #app{min-height:100vh;background:#fff;color:#111}
    h1{margin:0;padding:24px}
  </style></head><body>
  <div id="root"></div>
  <main id="app" hidden>
    <h1>Head Joystick</h1>
    <div class="joystick-container" id="joystick"></div>
    <div class="status" id="status">Yaw: 0 | Pitch: 0</div>
  </main>
  <script>
  (function(){
    var isEmbed = location.hash.indexOf('creds=') !== -1;
    if (!isEmbed) return;
    // Simulate connectToHost() resolving, then the corrected reveal+render.
    ${removeLine}
    var app = document.getElementById("app");
    app.hidden = false;
    parent.postMessage({ t: 'rendered' }, '*');
  })();
  </script>
  </body></html>`;
}

async function measure(page: import("@playwright/test").Page, removeRoot: boolean) {
  await page.route("**/space", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html><html><body>space</body></html>" }),
  );
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("http://localhost/space");
  await page.evaluate(async (doc) => {
    await new Promise((resolve) => {
      window.addEventListener("message", (e) => {
        if ((e.data as any)?.t === "rendered") resolve(null);
      });
      const url = URL.createObjectURL(new Blob([doc], { type: "text/html" }));
      const f = document.createElement("iframe");
      f.style.cssText = "width:800px;height:600px;border:0";
      f.src = url + "#creds=abc"; // embed mode
      document.body.appendChild(f);
      setTimeout(() => resolve(null), 3000);
    });
  }, embedDoc({ removeRoot }));

  return page.evaluate(() => {
    const f = document.querySelector("iframe") as HTMLIFrameElement;
    const d = f.contentDocument!;
    const w = f.contentWindow!;
    const cx = Math.floor(w.innerWidth / 2);
    const cy = Math.floor(w.innerHeight / 2);
    const top = d.elementFromPoint(cx, cy) as HTMLElement | null;
    const app = d.getElementById("app");
    const topInApp = !!(top && app && (top === app || app.contains(top)));
    const cs = app ? w.getComputedStyle(app) : null;
    return {
      topId: top?.id || top?.tagName || null,
      topInApp,
      hasRoot: !!d.getElementById("root"),
      appHidden: app ? (app as HTMLElement).hidden : null,
      appVisibility: cs?.visibility ?? null,
      appDisplay: cs?.display ?? null,
      appOpacity: cs?.opacity ?? null,
    };
  });
}

test("buggy contract: empty #root overlays #app -> center hits #root (black screen)", async ({ page }) => {
  const r = await measure(page, false);
  expect(r.hasRoot).toBe(true);
  // The empty, fixed, dark #root is the top element at the center -> the UI is
  // covered even though #app is revealed and filled.
  expect(r.topInApp).toBe(false);
  expect(r.topId).toBe("root");
});

test("fixed contract: embed removes #root -> app UI is the top element (visible)", async ({ page }) => {
  const r = await measure(page, true);
  expect(r.hasRoot).toBe(false);
  expect(r.appHidden).toBe(false);
  expect(r.appVisibility).toBe("visible");
  expect(r.appDisplay).not.toBe("none");
  expect(Number(r.appOpacity)).toBeGreaterThan(0);
  // The app UI (or a descendant) is actually the top-most thing at the center.
  expect(r.topInApp).toBe(true);
});
