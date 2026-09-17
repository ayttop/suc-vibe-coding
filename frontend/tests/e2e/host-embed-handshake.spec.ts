import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { wrapStandaloneWithEmbed } from "../../src/components/PreviewFrame";

/**
 * Option D regression: the vibe-coder preview must run a LIVE host session, not
 * hang on the "link" step.
 *
 * Root cause of the hang: the host embeds `new URL(embedPath, origin)` and the
 * default `/?embedded=1` serves the vibe-coder SPA on a `sdk: static` Space, so
 * the embed handshake never happens. Fix: `wrapStandaloneWithEmbed` exposes the
 * REAL app as a same-origin `blob:` URL via `window.__REACHY_MINI_EMBED_URL__`,
 * which the app passes as `mountHost({ embedPath })`.
 *
 * This test uses the ACTUAL `wrapStandaloneWithEmbed` output and a hand-rolled
 * host/embed pair that mirrors the SDK contract (useHostBridge.ts): the host
 * accepts `embed:ready` only from `event.origin === window.location.origin` and
 * posts `host:init` back with that exact target origin. It asserts the full
 * handshake completes over the nested blob, which is exactly what unblocks the
 * "link" step in preview.
 */

// Base app doc. Standalone branch acts as a minimal host that embeds
// `window.__REACHY_MINI_EMBED_URL__` (set by the wrapper's bootstrap). Embed
// branch (detected via the `#creds=` fragment the host appends) does the
// protocol-v1 embed side.
const BASE_DOC = `<!doctype html><html><head></head><body>app
<script>
(function(){
  var HOST_ORIGIN = location.origin;
  var isEmbed = location.hash.indexOf('creds=') !== -1;
  if (isEmbed) {
    parent.postMessage({ t:'embed:ready', origin:String(location.origin), hash:String(location.hash) }, '*');
    addEventListener('message', function(e){
      if (e.data && e.data.t === 'host:init') {
        parent.postMessage({ t:'embed:init-seen', from:String(e.origin) }, '*');
      }
    });
  } else {
    var results = { hostOrigin: HOST_ORIGIN, hasEmbedUrl: false, embedUrlScheme: null, sameOriginPass: null, embedHash: null, initSeen: false };
    var embedUrl = window.__REACHY_MINI_EMBED_URL__;
    results.hasEmbedUrl = !!embedUrl;
    results.embedUrlScheme = embedUrl ? String(embedUrl).split(':')[0] : null;
    addEventListener('message', function(e){
      var d = e.data || {};
      if (d.t === 'embed:ready') {
        results.sameOriginPass = (e.origin === HOST_ORIGIN);
        results.embedHash = d.hash;
        try { e.source.postMessage({ t:'host:init' }, HOST_ORIGIN); } catch(err) { results.initErr = String(err); }
      }
      if (d.t === 'embed:init-seen') {
        results.initSeen = (d.from === HOST_ORIGIN);
        top.postMessage({ t:'PROBE_DONE', results: results }, '*');
      }
    });
    if (embedUrl) {
      // Mirror the host: new URL(embedPath, origin).toString() + '#' + hash.
      var f = document.createElement('iframe');
      f.src = embedUrl + '#creds=abc';
      document.body.appendChild(f);
    }
    setTimeout(function(){ top.postMessage({ t:'PROBE_DONE', results: results }, '*'); }, 2500);
  }
})();
</script>
</body></html>`;

test("preview host embeds the real app via blob embedPath and completes the handshake", async ({
  page,
}) => {
  await page.route("**/space", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body>space</body></html>",
    }),
  );
  await page.goto("http://localhost/space");

  const standaloneDoc = wrapStandaloneWithEmbed(BASE_DOC);

  const results = await page.evaluate(async (doc) => {
    return await new Promise((resolve) => {
      window.addEventListener("message", (e) => {
        if ((e.data as any)?.t === "PROBE_DONE") resolve((e.data as any).results);
      });
      const url = URL.createObjectURL(new Blob([doc], { type: "text/html" }));
      const f = document.createElement("iframe");
      f.src = url; // standalone preview doc, loaded like PreviewFrame does
      document.body.appendChild(f);
      setTimeout(() => resolve({ timeout: true }), 6000);
    });
  }, standaloneDoc);

  writeFileSync(
    "/tmp/host_embed_handshake.json",
    JSON.stringify(results, null, 2),
  );

  // The wrapper exposed the app as a same-origin blob embedPath.
  expect(results.hasEmbedUrl).toBe(true);
  expect(results.embedUrlScheme).toBe("blob");
  // The embed's `embed:ready` arrived same-origin -> host bridge accepts it.
  expect(results.sameOriginPass).toBe(true);
  // The creds fragment survived into the embed doc.
  expect(results.embedHash).toBe("#creds=abc");
  // `host:init` was delivered back to the embed with the host's origin.
  expect(results.initSeen).toBe(true);
});
