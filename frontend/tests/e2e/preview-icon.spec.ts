import { test, expect } from "@playwright/test";
import { wrapStandaloneWithEmbed } from "../../src/components/PreviewFrame";

/**
 * Preview icon regression: the host top bar's `<img src="icon.svg">` is relative
 * and the preview runs from a `blob:` document, which has no fetchable relative
 * base - so `icon.svg` (and even `/icon.svg`) never load and the top bar shows
 * no icon. `wrapStandaloneWithEmbed(doc, origin)` injects `<base href=origin/>`
 * so the icon resolves to `<origin>/icon.svg`, which we serve from the
 * vibe-coder frontend (`public/icon.svg`).
 *
 * This test loads a wrapped doc whose body mimics the host top bar image and
 * asserts the icon actually loads (naturalWidth > 0) from the served origin.
 */

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/></svg>`;

test("wrapped preview doc loads icon.svg via injected <base href>", async ({ page }) => {
  await page.route("**/space", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html><html><body>space</body></html>" }),
  );
  // Stand in for the vibe-coder serving public/icon.svg at the Space root.
  await page.route("**/icon.svg", (r) =>
    r.fulfill({ contentType: "image/svg+xml", body: SVG }),
  );
  await page.goto("http://localhost/space");

  const baseDoc = `<!doctype html><html><head></head><body>` +
    `<img id="appicon" src="icon.svg" alt="app icon"></body></html>`;
  const wrapped = wrapStandaloneWithEmbed(baseDoc, "http://localhost");

  const res = await page.evaluate(async (doc) => {
    return await new Promise<{ src: string; w: number }>((resolve) => {
      const url = URL.createObjectURL(new Blob([doc], { type: "text/html" }));
      const f = document.createElement("iframe");
      f.src = url;
      f.onload = () => {
        const d = f.contentDocument!;
        const img = d.getElementById("appicon") as HTMLImageElement;
        setTimeout(() => resolve({ src: img.src, w: img.naturalWidth }), 500);
      };
      document.body.appendChild(f);
    });
  }, wrapped);

  expect(res.src).toBe("http://localhost/icon.svg");
  expect(res.w).toBeGreaterThan(0); // actually fetched + decoded
});
