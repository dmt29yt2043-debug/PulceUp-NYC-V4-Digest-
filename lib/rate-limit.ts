/**
 * Simple in-memory rate limiter (sliding window per key).
 *
 * Single-instance only — if we ever scale to multiple PM2 instances or
 * multiple VPS nodes, swap for Redis / @upstash/ratelimit.
 *
 * Usage:
 *   const ok = rateLimit(ip, 30, 60_000);  // 30 req per 60s
 *   if (!ok.allowed) return Response.json({error:'Too Many Requests'}, {status:429});
 */

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

// Periodic cleanup so we don't grow the Map unboundedly
let lastSweep = Date.now();
function sweep(now: number, windowMs: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, b] of buckets.entries()) {
    const cutoff = now - windowMs;
    b.timestamps = b.timestamps.filter((t) => t > cutoff);
    if (b.timestamps.length === 0) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSec: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  sweep(now, windowMs);

  const cutoff = now - windowMs;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(key, bucket);
  }
  // Drop timestamps outside the window
  bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

  if (bucket.timestamps.length >= limit) {
    const oldest = bucket.timestamps[0];
    const retryAfterMs = Math.max(0, windowMs - (now - oldest));
    return {
      allowed: false,
      remaining: 0,
      limit,
      retryAfterSec: Math.ceil(retryAfterMs / 1000),
    };
  }

  bucket.timestamps.push(now);
  return {
    allowed: true,
    remaining: limit - bucket.timestamps.length,
    limit,
    retryAfterSec: 0,
  };
}

/**
 * Extract a stable key from the request (IP). Falls back to 'unknown'.
 * Checks common reverse-proxy headers (Caddy sets X-Forwarded-For).
 */
export function getClientKey(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}
