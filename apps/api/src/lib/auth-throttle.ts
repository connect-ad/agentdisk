/**
 * Per-address throttles for the two places a guess gets an answer.
 *
 * Keys are 32 base62 characters and claim tokens 40, so nobody guesses one;
 * the risk these limits address is cost and noise, not compromise. A flood of
 * bad credentials used to cost a D1 lookup each and nothing stopped it, and
 * the claim preview, unauthenticated by design, answered every unknown token
 * one by one. Both now count failures per IP and refuse an address that has
 * failed too often, before the lookup it would otherwise have cost.
 *
 * Two rules carried over from the share-password throttle beside this:
 *
 *   - **Only failures count.** A valid key is never charged, so a busy agent
 *     cannot lock itself out by working hard. The counter is read on every
 *     request (one cached KV read) and written only when a credential fails.
 *   - **A locked address is refused outright, valid key or not.** This is the
 *     fail2ban shape and it is deliberate: the point is to stop paying for
 *     the flood, and the flood cannot be told from a legitimate caller on the
 *     same address without the lookup being avoided. The threshold is set
 *     where a misconfigured client never reaches it - a wrong key in an MCP
 *     config fails a handful of times, not thirty - and the window is short.
 *
 * The 401 body stays byte-identical across every failure, as
 * `test/auth.test.ts` pins; the throttle changes when a caller is answered,
 * never what a failure says.
 */

import { ApiError } from "./errors";
import { consume, isExhausted, type RateLimitRule } from "./rate-limit";

/** The address to count against: Cloudflare's header, or one shared bucket. */
export function addressOf(ip: string | null | undefined): string {
  return ip ?? "unknown-ip";
}

/** Failed credentials on /v1/* and /mcp: 30 per 15 minutes per address. */
export const AUTH_FAILURE_RATE_LIMIT: RateLimitRule = {
  bucket: "auth-failure",
  limit: 30,
  windowSeconds: 15 * 60,
};

/** Unknown or unusable claim tokens, previewed or claimed: the same figure. */
export const CLAIM_GUESS_RATE_LIMIT: RateLimitRule = {
  bucket: "claim-guess",
  limit: 30,
  windowSeconds: 15 * 60,
};

function secondsLeftInWindow(rule: RateLimitRule, now: number): number {
  const windowMs = rule.windowSeconds * 1000;
  return Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
}

/**
 * Refuse a caller whose address has spent this window's failures.
 *
 * `kv` is optional so the middleware can still be driven with no namespace
 * (tests do, and so would a deployment without the binding); absent, there is
 * no throttle rather than a crash.
 */
export async function refuseIfLockedOut(
  kv: KVNamespace | undefined,
  rule: RateLimitRule,
  address: string,
  now: number,
  what: string
): Promise<void> {
  if (kv === undefined) return;
  if (await isExhausted(kv, rule, address, now)) {
    throw new ApiError(
      "LIMIT_EXCEEDED",
      `Too many failed ${what} from this address. Try again in a few minutes.`,
      {
        details: { limit: "requests", retryAfterSeconds: secondsLeftInWindow(rule, now) },
        internalReason: `${rule.bucket}: ${address} locked out after ${rule.limit} failures`,
      }
    );
  }
}

/**
 * Count one failure against the caller's address.
 *
 * Awaited, not fired-and-forgotten: the count has to be visible to the very
 * next request from the same address or a tight loop of guesses outruns it.
 * A KV error is logged and swallowed - a broken counter must not turn every
 * 401 into a 500.
 */
export async function recordFailure(
  kv: KVNamespace | undefined,
  rule: RateLimitRule,
  address: string,
  now: number
): Promise<void> {
  if (kv === undefined) return;
  try {
    await consume(kv, rule, address, now);
  } catch (err) {
    console.log(
      JSON.stringify({
        level: "warn",
        message: "failure counter write failed",
        bucket: rule.bucket,
        reason: err instanceof Error ? err.message : String(err),
      })
    );
  }
}
