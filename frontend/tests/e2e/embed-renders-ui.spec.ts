import { test, expect } from "@playwright/test";
import { wrapStandaloneWithEmbed } from "../../src/components/PreviewFrame";

/**
 * Black-screen regression: after a successful embed handshake the app must
 * render VISIBLE, non-empty UI - not just "connect".
 *
 * Root cause of the black screen: `connectToHost()` pushes `phase:'live'` and
 * then resolves (embed/index.ts:343,350). The host removes its connecting
 * overlay and makes the embed iframe VISIBLE at `live`; it NEVER reveals the
 * app's own surface. `index.html` ships `<main id="app" hidden>`, so an app
 * whose embed branch forgets to un-hide `#app` and render into it shows a black
 * (dark-themed, empty) screen.
 *
 * This test drives the real `wrapStandaloneWithEmbed` + a template-shaped app.
 * The standalone branch acts as a minimal host (embeds the blob, sends
 * host:init); the embed branch mirrors the corrected template: await connect ->
 * reveal `#app` -> render UI. It asserts the embed doc's `#app` ends up VISIBLE
 * with real content. A companion negative case proves an app that skips the
 * reveal stays hidden (the bug).
 */

function appDoc(opts: { reveal: boolean }): string {
  // Standalone branch = fake host (reads embedPath, embeds it, sends host:init
  // once the embed says ready). Embed branch = template pattern: "connect"
  // (ready->init), then reveal #app + render.
  const revealLine = opts.reveal
    ? `app.hidden = false; app.appendChild(Object.assign(document.createElement("button"), { textContent: "Move head" }));`
    : `/* BUG: app never revealed/rendered */`;
  return `<!doctype html><html><head></head><body>
<div id="root"></div>
<main id="app" hidden></main>
<script>
(function(){
  var HOST_ORIGIN = location.origin;
  var isEmbed = location.hash.indexOf('creds=') !== -1;
  if (isEmbed) {
    // Minimal "connectToHost": announce ready, wait for host:init, then render.
    parent.postMessage({ t:'embed:ready' }, '*');
    addEventListener('message', function(e){
      if (e.data && e.data.t === 'host:init') {
        // === corrected template embed pattern ===
        var app = document.getElementById("app");
        ${revealLine}
        parent.postMessage({ t:'embed:rendered' }, '*');
      }
    });
  } else {
    var embedUrl = window.__REACHY_MINI_EMBED_URL__;
    addEventListener('message', function(e){
      var d = e.data || {};
      if (d.t === 'embed:ready') { try { e.source.postMessage({ t:'host:init' }, HOST_ORIGIN); } catch(_e){} }
      if (d.t === 'embed:rendered') { top.postMessage({ t:'DONE' }, '*'); }
    });
    var f = document.createElement('iframe');
    f.src = embedUrl + '#creds=abc';
    document.body.appendChild(f);
    setTimeout(function(){ top.postMessage({ t:'DONE' }, '*'); }, 3000);
  }
})();
</script>
</body></html>`;
}

async function runAndInspectApp(page: import("@playwright/test").Page, reveal: boolean) {
  await page.route("**/space", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html><html><body>space</body></html>" }),
  );
  await page.goto("http://localhost/space");
  const standaloneDoc = wrapStandaloneWithEmbed(appDoc({ reveal }));
  await page.evaluate(async (doc) => {
    await new Promise((resolve) => {
      window.addEventListener("message", (e) => {
        if ((e.data as any)?.t === "DONE") resolve(null);
      });
      const url = URL.createObjectURL(new Blob([doc], { type: "text/html" }));
      const f = document.createElement("iframe");
      f.src = url;
      document.body.appendChild(f);
      setTimeout(() => resolve(null), 3500);
    });
  }, standaloneDoc);
  // Traverse: page -> standalone iframe -> embed iframe -> #app (all same-origin).
  return page.evaluate(() => {
    const outer = document.querySelector("iframe") as HTMLIFrameElement;
    const inner = outer.contentDocument?.querySelector("iframe") as HTMLIFrameElement;
    const app = inner?.contentDocument?.getElementById("app");
    return {
      found: !!app,
      hidden: app ? (app as HTMLElement).hidden : null,
      childCount: app ? app.childElementCount : -1,
      text: app ? (app.textContent || "").trim() : "",
    };
  });
}

test("embed app reveals #app and renders visible content after handshake", async ({ page }) => {
  const r = await runAndInspectApp(page, true);
  expect(r.found).toBe(true);
  expect(r.hidden).toBe(false);
  expect(r.childCount).toBeGreaterThan(0);
  expect(r.text).toContain("Move head");
});

test("negative: an embed app that skips the reveal stays hidden (the black screen)", async ({ page }) => {
  const r = await runAndInspectApp(page, false);
  expect(r.found).toBe(true);
  // Reproduces the bug: #app is present but hidden + empty -> black screen.
  expect(r.hidden).toBe(true);
  expect(r.childCount).toBe(0);
});
