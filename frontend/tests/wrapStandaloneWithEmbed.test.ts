// @vitest-environment node
// PreviewFrame imports the esbuild-wasm bundler, whose TextEncoder invariant
// fails under jsdom (different realm). Run this suite in Node.
import { describe, it, expect } from "vitest";
import { wrapStandaloneWithEmbed } from "../src/components/PreviewFrame";

describe("wrapStandaloneWithEmbed", () => {
  it("injects the embed bootstrap that exposes __REACHY_MINI_EMBED_URL__", () => {
    const base = `<!doctype html><html><head></head><body>ok</body></html>`;
    const out = wrapStandaloneWithEmbed(base);
    expect(out).toContain("__REACHY_MINI_EMBED_URL__");
    expect(out).toContain("URL.createObjectURL");
    expect(out).toContain("new Blob(");
    // bootstrap lands inside <head> (runs before the app module)
    expect(out).toMatch(/<head[^>]*>\s*<script>/i);
  });

  it("escapes </script> in the embedded literal so it can't close the bootstrap early", () => {
    const base = `<!doctype html><html><head></head><body><script>console.log("hi")</script></body></html>`;
    const out = wrapStandaloneWithEmbed(base);
    // The bootstrap's embedded literal must not contain a raw closing tag; it
    // is escaped as `<\/script`. There is exactly ONE real closing </script>
    // (the bootstrap's own), so the doc stays parseable.
    const escaped = out.split("<\\/script").length - 1;
    expect(escaped).toBeGreaterThanOrEqual(1);
    // The literal round-trips: unescaping recovers the original base doc.
    const m = out.match(/new Blob\(\[(.*)\], \{ type: "text\/html" \}\)/s);
    expect(m).toBeTruthy();
    const literal = m![1];
    const recovered = JSON.parse(literal.replace(/<\\\/(script)/gi, "</$1"));
    expect(recovered).toBe(base);
  });

  it("does not nest a second bootstrap into the embedded doc (no recursion)", () => {
    const base = `<!doctype html><html><head></head><body>x</body></html>`;
    const out = wrapStandaloneWithEmbed(base);
    // The recovered embedded doc must be the pristine base, WITHOUT another
    // __REACHY_MINI_EMBED_URL__ bootstrap inside it.
    const m = out.match(/new Blob\(\[(.*)\], \{ type: "text\/html" \}\)/s);
    const recovered = JSON.parse(m![1].replace(/<\\\/(script)/gi, "</$1"));
    expect(recovered).not.toContain("__REACHY_MINI_EMBED_URL__");
  });

  it("injects <base href> when a baseOrigin is given (icon.svg loads in preview)", () => {
    const base = `<!doctype html><html><head></head><body>x</body></html>`;
    const out = wrapStandaloneWithEmbed(base, "https://tfrere-app.hf.space");
    // base tag present, normalized to a single trailing slash, before bootstrap
    expect(out).toContain(`<base href="https://tfrere-app.hf.space/">`);
    expect(out.indexOf("<base ")).toBeLessThan(out.indexOf("__REACHY_MINI_EMBED_URL__"));
  });

  it("omits <base href> when no baseOrigin is given", () => {
    const out = wrapStandaloneWithEmbed(`<html><head></head><body>x</body></html>`);
    expect(out).not.toContain("<base ");
  });

  it("falls back to prepending the bootstrap when there is no <head>", () => {
    const base = `<body>no head here</body>`;
    const out = wrapStandaloneWithEmbed(base);
    expect(out.indexOf("__REACHY_MINI_EMBED_URL__")).toBeLessThan(
      out.indexOf("no head here"),
    );
  });
});
