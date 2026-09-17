// @vitest-environment node
import { describe, it, expect } from "vitest";
import { generateStickerIcon, isValidSvg, svgToDataUrl } from "../src/lib/sticker";

const VALID_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
  `<path fill="#F8F7F5" d="M10 10h80v80H10z"/>` +
  `<circle cx="50" cy="50" r="30" fill="#111"/>` +
  `<path d="M20 20 L80 80 M80 20 L20 80" stroke="#000"/></svg>`;

type Handler = (url: string, init?: RequestInit) => unknown;

/** Build a Response-like object. */
function res(body: unknown, opts: { ok?: boolean; status?: number; text?: boolean } = {}) {
  const ok = opts.ok ?? true;
  return {
    ok,
    status: opts.status ?? (ok ? 200 : 500),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** Deterministic fetch mock driven by a per-URL handler. */
function mockFetch(handler: Handler): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    return handler(url, init) as Response;
  }) as unknown as typeof fetch;
}

const fast = { sleep: async () => {}, pollIntervalMs: 1 };

describe("generateStickerIcon", () => {
  it("happy path: generate -> poll -> fetch svg -> writes svg (and sends the prompt)", async () => {
    let sentPrompt = "";
    let polls = 0;
    const fetchImpl = mockFetch((url, init) => {
      if (url.endsWith("/api/generate")) {
        sentPrompt = JSON.parse(String(init?.body)).prompt;
        return res({ job_id: "job123", status_url: "/api/jobs/job123" });
      }
      if (url.includes("/api/jobs/job123")) {
        polls += 1;
        return res(
          polls < 2
            ? { status: "processing" }
            : { status: "done", svg_url: "/api/community/abc.svg" },
        );
      }
      if (url.includes("/api/community/abc.svg")) return res(VALID_SVG, { text: true });
      throw new Error(`unexpected url ${url}`);
    });

    const out = await generateStickerIcon("a happy reachy robot", {
      fetchImpl,
      ...fast,
    });
    expect(out.ok).toBe(true);
    expect(out.svg).toContain("<svg");
    expect(sentPrompt).toBe("a happy reachy robot");
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it("timeout -> fallback reason (no throw)", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.endsWith("/api/generate")) return res({ job_id: "j" });
      if (url.includes("/api/jobs/")) return res({ status: "processing" });
      throw new Error("no svg expected");
    });
    let t = 0;
    const out = await generateStickerIcon("x", {
      fetchImpl,
      sleep: async () => {},
      pollIntervalMs: 1,
      timeoutMs: 50,
      now: () => (t += 20), // advances past the 50ms budget within a few polls
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/timed out/i);
  });

  it("invalid (non-SVG) response -> rejected + fallback", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.endsWith("/api/generate")) return res({ job_id: "j" });
      if (url.includes("/api/jobs/")) return res({ status: "done", svg_url: "/api/community/x.svg" });
      if (url.includes(".svg")) return res("<!doctype html><html>error page</html>", { text: true });
      throw new Error("unexpected");
    });
    const out = await generateStickerIcon("x", { fetchImpl, ...fast });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/invalid|non-svg/i);
  });

  it("job failure status -> rejected with detail", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.endsWith("/api/generate")) return res({ job_id: "j" });
      if (url.includes("/api/jobs/")) return res({ status: "error", detail: "quota exceeded" });
      throw new Error("unexpected");
    });
    const out = await generateStickerIcon("x", { fetchImpl, ...fast });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/quota exceeded/);
  });

  it("generate HTTP error -> rejected", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.endsWith("/api/generate")) return res({ error: "bad" }, { ok: false, status: 500 });
      throw new Error("unexpected");
    });
    const out = await generateStickerIcon("x", { fetchImpl, ...fast });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/HTTP 500/);
  });

  it("abort during polling stops immediately with 'cancelled' (no further fetch)", async () => {
    const controller = new AbortController();
    let jobFetches = 0;
    const fetchImpl = mockFetch((url, init) => {
      if ((init as { signal?: AbortSignal } | undefined)?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (url.endsWith("/api/generate")) return res({ job_id: "j" });
      if (url.includes("/api/jobs/")) {
        jobFetches += 1;
        if (jobFetches === 2) controller.abort(); // user hits stop mid-poll
        return res({ status: "processing" });
      }
      throw new Error("must not fetch the svg after cancel");
    });
    // Abortable sleep that clears its timer on abort (mirrors the real one).
    const abortableSleep = (ms: number, signal?: AbortSignal) =>
      new Promise<void>((r) => {
        if (signal?.aborted) return r();
        const t = setTimeout(r, 1);
        signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
      });

    const out = await generateStickerIcon("x", {
      fetchImpl,
      sleep: abortableSleep,
      pollIntervalMs: 1,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("cancelled");
    expect(jobFetches).toBe(2); // stopped right after the abort, no 3rd poll
  });

  it("a pre-aborted signal yields 'cancelled' without generating a sticker", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = mockFetch((_url, init) => {
      if ((init as { signal?: AbortSignal } | undefined)?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return res({ job_id: "j" });
    });
    const out = await generateStickerIcon("x", {
      fetchImpl,
      sleep: async () => {},
      pollIntervalMs: 1,
      signal: controller.signal,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/cancel/i);
  });

  it("empty prompt is rejected before any network call", async () => {
    let called = false;
    const fetchImpl = mockFetch(() => {
      called = true;
      return res({});
    });
    const out = await generateStickerIcon("   ", { fetchImpl, ...fast });
    expect(out.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe("isValidSvg / svgToDataUrl", () => {
  it("accepts real svg, rejects junk", () => {
    expect(isValidSvg(VALID_SVG)).toBe(true);
    expect(isValidSvg("<html>nope</html>")).toBe(false);
    expect(isValidSvg("")).toBe(false);
    expect(isValidSvg(null)).toBe(false);
  });

  it("builds an svg+xml data URL", () => {
    const u = svgToDataUrl(VALID_SVG);
    expect(u.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });
});
