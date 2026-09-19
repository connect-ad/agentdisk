/**
 * KV-counter rate limiting - 05 PART 10.9, 06 PART 16.14.
 *
 * Fixed windows over KV. Explicitly the *eventually consistent* tier of the
 * three the design describes: a caller spread across Cloudflare PoPs can
 * briefly exceed the limit before the counter catches up, and two requests in
 * the same instant can both read the same count and both write count+1, losing
 * one increment. 16.14 accepts that slop for coarse per-IP and per-key limits.
 *
 * What it is *not* suitable for is anything where an exact count matters -
 * that is the Durable Object tier, which 14.3 reserves for MCP per-session
 * throttling. Do not reach for this there.
 */

import { ApiError } from "./errors";

export interface RateLimitRule {
  /** Names the counter family, e.g. "workspace-create". */
  bucket: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Unix ms when the current window ends. */
  resetAt: number;
}

/**
 * KV's minimum expirationTtl. A window shorter than this cannot be expressed as
 * a self-expiring key, so we refuse rather than silently keeping a counter
 * alive longer than its window.
 */
const MIN_KV_TTL_SECONDS = 60;

export async function consume(
  kv: KVNamespace,
  rule: RateLimitRule,
  identifier: string,
  now: number
): Promise<RateLimitResult> {
  if (rule.windowSeconds < MIN_KV_TTL_SECONDS) {
    throw new Error(
      `Rate-limit window ${rule.windowSeconds}s is below KV's ${MIN_KV_TTL_SECONDS}s minimum TTL.`
    );
  }

  const windowMs = rule.windowSeconds * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;
  const key = `rl:${rule.bucket}:${identifier}:${windowStart}`;

  const current = Number.parseInt((await kv.get(key)) ?? "0", 10);
  const used = Number.isFinite(current) && current > 0 ? current : 0;

  if (used >= rule.limit) {
    return { allowed: false, remaining: 0, resetAt };
  }

  // TTL covers two windows so a counter written at the very end of one is still
  // readable for the whole of it, and expires on its own afterwards.
  await kv.put(key, String(used + 1), { expirationTtl: rule.windowSeconds * 2 });

  return { allowed: true, remaining: rule.limit - used - 1, resetAt };
}

export async function enforce(
  kv: KVNamespace,
  rule: RateLimitRule,
  identifier: string,
  now: number
): Promise<RateLimitResult> {
  const result = await consume(kv, rule, identifier, now);
  if (!result.allowed) {
    throw new ApiError("LIMIT_EXCEEDED", "Too many requests. Try again shortly.", {
      details: {
        limit: "requests",
        retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt - now) / 1000)),
      },
    });
  }
  return result;
}

/**
 * The identifier to count against for an unauthenticated caller.
 *
 * CF-Connecting-IP is set by Cloudflare's own edge and cannot be spoofed by the
 * client. If it is somehow absent, every such caller shares one bucket - a
 * stricter limit, not a looser one, which is the only safe direction for a
 * fallback in a rate limiter.
 */
export function clientIdentifier(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown-ip";
}
