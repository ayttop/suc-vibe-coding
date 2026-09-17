import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPreviewDoc } from "../../src/components/PreviewFrame";

// "Test up to deployment": mount a real `buildPreviewDoc` output in a
// headless browser and assert the runtime contract the auto-fix loop relies
// on - the reporter boots, environmental noise stays non-actionable (log),
// and own-code errors surface as actionable.

const INDEX =
  '<!doctype html><html><head></head>' +
  '<body><script src="./main.js"></script></body></html>';

async function renderDoc(
  page: import("@playwright/test").Page,
  files: { path: string; content: string }[],
  docId: number,
) {
  const doc = await buildPreviewDoc(files, null, docId);
  const dir = mkdtempSync(join(tmpdir(), "reachy-preview-"));
  const file = join(dir, "preview.html");
  writeFileSync(file, doc ?? "");
  // Collect the reporter's postMessage traffic (the reporter posts to
  // `parent`, which on a top-level page is `window`).
  await page.addInitScript(() => {
    (window as unknown as { __msgs: unknown[] }).__msgs = [];
    window.addEventListener("message", (e) => {
      (window as unknown as { __msgs: unknown[] }).__msgs.push(e.data);
    });
  });
  await page.goto("file://" + file);
}

function msgs(page: import("@playwright/test").Page) {
  return page.evaluate(
    () => (window as unknown as { __msgs: any[] }).__msgs ?? [],
  );
}

test("boots and stays clean when main.js is present", async ({ page }) => {
  await renderDoc(
    page,
    [
      { path: "index.html", content: INDEX },
      { path: "main.js", content: "/* healthy app */ void 0;" },
    ],
    201,
  );
  await expect
    .poll(async () => (await msgs(page)).some((m: any) => m?.kind === "booted"))
    .toBe(true);
  const all = await msgs(page);
  expect(all.some((m: any) => m?.severity === "error")).toBe(false);
});

test("no-robot console.warn is a non-actionable log, not an error", async ({
  page,
}) => {
  await renderDoc(
    page,
    [
      { path: "index.html", content: INDEX },
      {
        path: "main.js",
        content: 'console.warn("[reachy-mini] no robot online");',
      },
    ],
    202,
  );
  await expect
    .poll(async () =>
      (await msgs(page)).some(
        (m: any) => m?.kind === "console.warn" && m?.severity === "log",
      ),
    )
    .toBe(true);
  const all = await msgs(page);
  expect(all.some((m: any) => m?.severity === "error")).toBe(false);
});

test("own-code runtime error surfaces as an actionable error", async ({
  page,
}) => {
  await renderDoc(
    page,
    [
      { path: "index.html", content: INDEX },
      { path: "main.js", content: "thisSymbolDoesNotExist();" },
    ],
    203,
  );
  await expect
    .poll(async () =>
      (await msgs(page)).some(
        (m: any) => m?.severity === "error" && m?.origin === "own-code",
      ),
    )
    .toBe(true);
});
