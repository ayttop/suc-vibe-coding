import * as esbuild from "esbuild-wasm";

/**
 * Thin wrapper around esbuild-wasm used by the preview iframe to turn
 * `.ts`/`.tsx` files into ES2022 JavaScript before injection. Uses
 * `esbuild.transform` (per-file, no bundling graph) because the existing
 * inline-script inliner already resolves cross-file imports by pasting
 * everything into the srcDoc.
 *
 * The WASM binary is loaded from jsDelivr at a URL pinned to the version
 * declared in package.json. The first call pays the init cost
 * (~300-500ms); subsequent calls are essentially free thanks to the LRU.
 */
const WASM_VERSION = "0.28.0";
const WASM_URL = `https://cdn.jsdelivr.net/npm/esbuild-wasm@${WASM_VERSION}/esbuild.wasm`;

export interface CompileError {
  file: string;
  line: number;
  column: number;
  text: string;
}

export type CompileResult =
  | { ok: true; code: string }
  | { ok: false; error: CompileError };

let initPromise: Promise<void> | null = null;

function ensureInitialized(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = esbuild
    .initialize({ wasmURL: WASM_URL, worker: true })
    .catch((err) => {
      initPromise = null;
      throw err;
    });
  return initPromise;
}

async function sha1Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const CACHE_MAX = 128;
const cache = new Map<string, CompileResult>();

function cacheGet(key: string): CompileResult | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: CompileResult): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first === undefined) break;
    cache.delete(first);
  }
}

function pickLoader(path: string): "ts" | "tsx" | "js" | "jsx" {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".ts")) return "ts";
  if (path.endsWith(".jsx")) return "jsx";
  return "js";
}

export async function compileScript(
  path: string,
  source: string,
): Promise<CompileResult> {
  const key = `${path}::${await sha1Hex(source)}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  try {
    await ensureInitialized();
  } catch (err) {
    const result: CompileResult = {
      ok: false,
      error: {
        file: path,
        line: 0,
        column: 0,
        text: `esbuild-wasm failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
    cacheSet(key, result);
    return result;
  }

  try {
    const res = await esbuild.transform(source, {
      loader: pickLoader(path),
      target: "es2022",
      format: "esm",
      sourcemap: "inline",
      sourcefile: path,
      logLevel: "silent",
    });
    const result: CompileResult = { ok: true, code: res.code };
    cacheSet(key, result);
    return result;
  } catch (err) {
    const errors = (err as { errors?: esbuild.Message[] }).errors ?? [];
    const first = errors[0];
    const result: CompileResult = {
      ok: false,
      error: {
        file: first?.location?.file ?? path,
        line: first?.location?.line ?? 0,
        column: first?.location?.column ?? 0,
        text:
          first?.text ??
          (err instanceof Error ? err.message : "Unknown esbuild error"),
      },
    };
    cacheSet(key, result);
    return result;
  }
}

export function isCompilable(path: string): boolean {
  return /\.(tsx?|jsx)$/i.test(path);
}
