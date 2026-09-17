import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withDefaultIcon,
  inferSpaceSdk,
  describeHubError,
} from "../src/routes/publish.js";
import { REACHY_DEFAULT_ICON_SVG } from "../src/assets/default-app-icon.js";

test("withDefaultIcon injects a valid non-empty icon.svg when the app omits one", () => {
  const files = [
    { path: "index.html", content: "<!doctype html>" },
    { path: "main.js", content: "// app" },
    { path: "README.md", content: "---\nsdk: static\n---\n" },
  ];
  const out = withDefaultIcon(files);
  const icon = out.find((f) => f.path === "icon.svg");
  assert.ok(icon, "icon.svg must be present");
  assert.ok(icon!.content.length > 1000, "icon.svg must be non-trivial");
  assert.match(icon!.content, /<svg[\s>]/, "icon.svg must be valid SVG markup");
  assert.match(icon!.content, /<\/svg>\s*$/, "icon.svg must be a complete SVG");
  // original files preserved, input not mutated
  assert.equal(out.length, files.length + 1);
  assert.equal(files.length, 3);
});

test("withDefaultIcon does NOT overwrite an app-provided icon.svg", () => {
  const custom = { path: "icon.svg", content: "<svg>custom</svg>" };
  const out = withDefaultIcon([
    { path: "index.html", content: "x" },
    custom,
  ]);
  const icons = out.filter((f) => f.path.toLowerCase().endsWith("icon.svg"));
  assert.equal(icons.length, 1, "exactly one icon.svg");
  assert.equal(icons[0].content, "<svg>custom</svg>", "keeps the user's icon");
});

test("withDefaultIcon treats ./icon.svg / ICON.SVG as already present", () => {
  for (const p of ["./icon.svg", "ICON.SVG", "/icon.svg"]) {
    const out = withDefaultIcon([{ path: p, content: "<svg>x</svg>" }]);
    assert.equal(
      out.filter((f) => f.path.toLowerCase().replace(/^\.?\/+/, "") === "icon.svg")
        .length,
      1,
      `no duplicate for ${p}`,
    );
    assert.ok(!out.some((f) => f.content === REACHY_DEFAULT_ICON_SVG), `default not added for ${p}`);
  }
});

test("the embedded default icon is a valid non-empty SVG", () => {
  assert.ok(REACHY_DEFAULT_ICON_SVG.length > 1000);
  assert.match(REACHY_DEFAULT_ICON_SVG, /^<\?xml|^<svg/);
  assert.match(REACHY_DEFAULT_ICON_SVG, /<\/svg>\s*$/);
});

test("inferSpaceSdk tolerates BOM / leading blank lines", () => {
  assert.equal(inferSpaceSdk([{ path: "README.md", content: "\uFEFF\n---\nsdk: static\n---" }]), "static");
  assert.equal(inferSpaceSdk([{ path: "README.md", content: "---\nsdk: docker\n---" }]), "docker");
  assert.equal(inferSpaceSdk([{ path: "index.html", content: "<html>" }]), "docker");
});

test("describeHubError surfaces the parsed HF body", () => {
  const d = describeHubError({
    message: "Api error with status 400",
    statusCode: 400,
    requestId: "R",
    data: { error: "bad card" },
  });
  assert.match(d.message, /bad card/);
  assert.equal(d.statusCode, 400);
  assert.equal(d.requestId, "R");
});
