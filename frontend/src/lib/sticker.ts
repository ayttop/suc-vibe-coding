// Client-side driver for the Reachy Sticker Generator Space
// (pollen-robotics/reachy-sticker-generator). It runs entirely in the browser:
// the API sends permissive CORS headers for our origin (verified against the
// live Space), so no backend proxy is needed.
//
// Contract (confirmed with a live end-to-end call):
//   POST {base}/api/generate  { prompt, enhanced?, padding? }
//        -> 200 { job_id, status_url }
//   GET  {base}/api/jobs/{job_id}
//        -> 200 { status: "processing" | "done" | "error" | ...,
//                 svg_url: "/api/community/<id>.svg", png_url, id, detail }
//   GET  {base}{svg_url}  -> image/svg+xml (transparent SVG, ~12KB)
//
// A full run takes ~60s, so callers must be prepared to block/poll with a
// generous timeout and a robust fallback (keep the default icon on failure).

export const STICKER_API_BASE =
  "https://pollen-robotics-reachy-sticker-generator.hf.space";

export interface StickerResult {
  ok: boolean;
  /** The generated SVG markup (only when ok). */
  svg?: string;
  /** Sticker id / source URL, for logging + preview attribution. */
  svgUrl?: string;
  /** Human-readable failure reason (only when !ok) - shown to the user and
   *  handed back to the agent so it can keep the default icon. */
  reason?: string;
}

export interface GenerateStickerOptions {
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Overall budget before we give up and fall back. Default 120s. */
  timeoutMs?: number;
  /** Delay between job-status polls. Default 3s. */
  pollIntervalMs?: number;
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number;
  /** Injectable sleeper (tests). Default real `setTimeout`. Must resolve early
   *  (and clear its timer) when `signal` aborts, to avoid orphan timeouts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Abort the whole operation (e.g. user interrupt). */
  signal?: AbortSignal;
  /** Override the API base (tests / staging). */
  base?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 3_000;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Abortable sleep: resolves after `ms` OR immediately on abort, clearing the
// timer either way so no orphan setTimeout survives a cancel.
const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * A response is a usable SVG when it opens with an <svg> tag, closes with
 * </svg>, and carries real markup (guards against HTML error pages, empty
 * bodies, or a JSON error blob served with the wrong content-type).
 */
export function isValidSvg(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return t.length > 100 && /<svg[\s>]/i.test(t) && /<\/svg>\s*>?$/i.test(t);
}

/**
 * Generate a dedicated Reachy sticker icon. Blocking: resolves only once the
 * job completes, fails, or the timeout elapses. Never throws - every failure
 * path returns `{ ok: false, reason }` so the caller can keep the default icon.
 */
export async function generateStickerIcon(
  prompt: string,
  opts: GenerateStickerOptions = {},
): Promise<StickerResult> {
  const f = opts.fetchImpl ?? fetch;
  const base = (opts.base ?? STICKER_API_BASE).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? realSleep;
  const aborted = () => opts.signal?.aborted ?? false;

  const clean = prompt.trim();
  if (!clean) return { ok: false, reason: "empty prompt" };

  // 1. Kick off the job.
  let jobId: string;
  try {
    const res = await f(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: clean }),
      signal: opts.signal,
    });
    if (!res.ok) {
      return { ok: false, reason: `generation request failed (HTTP ${res.status})` };
    }
    const data = (await res.json()) as { job_id?: string };
    if (!data?.job_id) return { ok: false, reason: "no job_id returned" };
    jobId = data.job_id;
  } catch (e) {
    if (aborted()) return { ok: false, reason: "cancelled" };
    return { ok: false, reason: `could not reach the sticker service: ${errMsg(e)}` };
  }

  // 2. Poll until done / failed / timeout.
  const deadline = now() + timeoutMs;
  for (;;) {
    if (aborted()) return { ok: false, reason: "cancelled" };
    if (now() >= deadline) {
      return {
        ok: false,
        reason: `timed out after ${Math.round(timeoutMs / 1000)}s (the sticker service was slow or busy)`,
      };
    }
    await sleep(pollIntervalMs, opts.signal);
    if (aborted()) return { ok: false, reason: "cancelled" };

    let job: {
      status?: string;
      svg_url?: string;
      detail?: string | null;
    };
    try {
      const res = await f(`${base}/api/jobs/${encodeURIComponent(jobId)}`, {
        signal: opts.signal,
      });
      if (!res.ok) {
        return { ok: false, reason: `job status failed (HTTP ${res.status})` };
      }
      job = (await res.json()) as typeof job;
    } catch (e) {
      if (aborted()) return { ok: false, reason: "cancelled" };
      return { ok: false, reason: `network error while polling: ${errMsg(e)}` };
    }

    const status = String(job?.status ?? "").toLowerCase();
    if (status === "error" || status === "failed") {
      return {
        ok: false,
        reason: job?.detail ? `generation failed: ${job.detail}` : "generation failed",
      };
    }
    if (["done", "complete", "completed", "success", "finished"].includes(status)) {
      const svgUrl = job?.svg_url;
      if (!svgUrl) return { ok: false, reason: "job finished but returned no svg_url" };
      const abs = /^https?:\/\//i.test(svgUrl) ? svgUrl : `${base}${svgUrl}`;
      try {
        const res = await f(abs, { signal: opts.signal });
        if (!res.ok) return { ok: false, reason: `could not download the SVG (HTTP ${res.status})` };
        const svg = await res.text();
        if (!isValidSvg(svg)) {
          return { ok: false, reason: "the service returned an invalid (non-SVG) file" };
        }
        return { ok: true, svg, svgUrl: abs };
      } catch (e) {
        if (aborted()) return { ok: false, reason: "cancelled" };
        return { ok: false, reason: `network error downloading the SVG: ${errMsg(e)}` };
      }
    }
    // otherwise: queued / processing -> keep polling
  }
}

/** Base64 data URL for inline <img> preview of an SVG string. */
export function svgToDataUrl(svg: string): string {
  let b64: string;
  if (typeof btoa === "function") {
    // Browser (and Node >=16, which we use in tests): btoa needs Latin-1, so
    // round-trip through UTF-8 percent-encoding to keep non-ASCII glyphs.
    b64 = btoa(encodeURIComponent(svg).replace(/%([0-9A-F]{2})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    ));
  } else {
    const B = (globalThis as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } }).Buffer;
    b64 = B ? B.from(svg, "utf-8").toString("base64") : "";
  }
  return `data:image/svg+xml;base64,${b64}`;
}
