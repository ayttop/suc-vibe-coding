// @vitest-environment node
// Runs in node (not jsdom): buildPreviewDoc pulls in esbuild-wasm, whose
// import-time invariant (`new TextEncoder().encode("") instanceof
// Uint8Array`) is false under jsdom's split realm. This suite needs no DOM.
import { describe, it, expect } from "vitest";
import { buildPreviewDoc } from "../src/components/PreviewFrame";
import type { Diagnostic } from "../src/hooks/usePreviewDiagnostics";

// Invariant locked (Bug 3 mechanism + failure mode): a missing local asset
// produces exactly ONE structured compile-error and an inert stub - never a
// live <script src> that would fetch the parent SPA and surface a
// misleading "Unexpected token '<'".

const INDEX_WITH_MAIN =
  '<!doctype html><html><head></head>' +
  '<body><script src="./main.js"></script></body></html>';

describe("buildPreviewDoc - preview build failure mode", () => {
  it("missing local script -> one compile-error + inert stub, no live src, no parent fetch", async () => {
    const errs: Diagnostic[] = [];
    const doc = await buildPreviewDoc(
      [{ path: "index.html", content: INDEX_WITH_MAIN }],
      null,
      101,
      (d) => errs.push(d),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0].kind).toBe("compile-error");
    expect(errs[0].message.toLowerCase()).toContain("missing");
    expect(errs[0].file).toBe("./main.js");

    expect(doc).not.toBeNull();
    // The dangerous live reference must be gone (it would resolve against the
    // parent origin and fetch the vibe-coder SPA's index.html -> the app
    // would parse HTML as JS -> "Unexpected token '<'").
    expect(doc).not.toContain('src="./main.js"');
    // Replaced by an inert stub comment, not a working script.
    expect(doc!.toLowerCase()).toContain("missing");
  });

  it("present local script -> inlined cleanly, no compile-error", async () => {
    const errs: Diagnostic[] = [];
    const doc = await buildPreviewDoc(
      [
        { path: "index.html", content: INDEX_WITH_MAIN },
        { path: "main.js", content: "globalThis.__reachyOk = 123;" },
      ],
      null,
      102,
      (d) => errs.push(d),
    );
    expect(errs).toHaveLength(0);
    expect(doc).not.toBeNull();
    expect(doc).not.toContain('src="./main.js"'); // inlined, not referenced
    expect(doc).toContain("globalThis.__reachyOk = 123;");
  });

  it("leaves remote CDN scripts un-inlined and not flagged missing", async () => {
    const cdn =
      "https://cdn.jsdelivr.net/npm/@pollen-robotics/reachy-mini-sdk@1.8.0/+esm";
    const errs: Diagnostic[] = [];
    const doc = await buildPreviewDoc(
      [
        {
          path: "index.html",
          content:
            `<!doctype html><html><head>` +
            `<script type="module">import x from "${cdn}";</script>` +
            `</head><body></body></html>`,
        },
      ],
      null,
      103,
      (d) => errs.push(d),
    );
    expect(errs).toHaveLength(0);
    expect(doc).toContain(cdn);
  });

  it("reflects a VFS icon.svg as the preview app icon (data URL global)", async () => {
    const icon =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>';
    const doc = await buildPreviewDoc(
      [
        { path: "index.html", content: INDEX_WITH_MAIN },
        { path: "main.js", content: "// noop" },
        { path: "icon.svg", content: icon },
      ],
      null,
      105,
    );
    // The generated/custom icon is exposed to the template so the preview top
    // bar shows the REAL icon, not the served static default.
    expect(doc).toContain("__REACHY_MINI_ICON_URL__");
    expect(doc).toContain("data:image/svg+xml;base64,");
  });

  it("omits the icon global when the VFS has no icon.svg", async () => {
    const doc = await buildPreviewDoc(
      [
        { path: "index.html", content: INDEX_WITH_MAIN },
        { path: "main.js", content: "// noop" },
      ],
      null,
      106,
    );
    expect(doc).not.toContain("__REACHY_MINI_ICON_URL__");
  });

  it("injects the preview token when provided (skips OAuth in the sandbox)", async () => {
    const doc = await buildPreviewDoc(
      [
        { path: "index.html", content: INDEX_WITH_MAIN },
        { path: "main.js", content: "// noop" },
      ],
      "hf_demo_token",
      104,
    );
    expect(doc).toContain("__REACHY_MINI_PREVIEW_TOKEN__");
    expect(doc).toContain("hf_demo_token");
  });
});
