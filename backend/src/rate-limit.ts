import type { Context, MiddlewareHandler } from "hono";
import type { AppBindings } from "./types.js";

interface Bucket {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  windowMs: number;
  max: number;
  /**
   * Key extractor. Defaults to the authenticated HF username, falling back
   * to `x-forwarded-for` then "anon". That way a single HF user can't bypass
   * the cap by opening multiple tabs, but unauthenticated callers on shared
   * IPs (rare, we require auth in prod) still share a bucket.
   */
  key?: (c: Context<AppBindings>) => string;
}

/**
 * Minimal in-memory rate limiter. Good enough for a single-process Space -
 * if we ever scale to multiple workers this needs to move to Redis/KV.
 *
 * Buckets are lazily pruned every ~1000 calls to keep the Map bounded;
 * resetAt-based expiry means even without pruning the footprint stays low
 * (a stale bucket just gets overwritten on the next hit from the same key).
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppBindings> {
  const { windowMs, max } = options;
  const getKey =
    options.key ??
    ((c: Context<AppBindings>) =>
      c.get("hfUser")?.name ??
      c.req.header("x-forwarded-for") ??
      c.req.header("x-real-ip") ??
      "anon");

  const buckets = new Map<string, Bucket>();
  let tick = 0;

  return async (c, next) => {
    const now = Date.now();
    tick++;
    if (tick % 1000 === 0) {
      for (const [k, b] of buckets) {
        if (b.resetAt < now) buckets.delete(k);
      }
    }

    const key = getKey(c);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 1, resetAt: now + windowMs };
      buckets.set(key, bucket);
    } else {
      bucket.count++;
    }

    const remaining = Math.max(0, max - bucket.count);
    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      c.header("Retry-After", String(retryAfter));
      return c.json(
        {
          error:
            `Rate limit exceeded (${max} requests per ${Math.round(
              windowMs / 1000,
            )}s). Try again in ${retryAfter}s.`,
        },
        429,
      );
    }

    await next();
  };
}
