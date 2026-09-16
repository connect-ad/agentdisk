/**
 * API key generation and verification - 06 PART 15.3 and 16.4.
 *
 * The invariants this file holds:
 *
 *  - The raw secret is returned exactly once, by generateApiKey, and is never
 *    written anywhere by this module. Only SHA-256 of it reaches the database.
 *  - Randomness is crypto.getRandomValues, never Math.random, and the base62
 *    encoding uses rejection sampling so the alphabet stays uniform. A modulo
 *    fold of 256 into 62 would make the first eight characters measurably more
 *    likely to be low letters, which is entropy quietly thrown away.
 *  - A key is read from the Authorization header and nowhere else. Query
 *    strings end up in access logs, browser history and Referer headers.
 */

export const LIVE_PREFIX = "ask_live_";
export const TEST_PREFIX = "ask_test_";

/** 32 base62 characters is ~190 bits, matching the 24 random bytes 15.3 asks for. */
export const SECRET_LENGTH = 32;

/** How much of the secret is stored in cleartext alongside the prefix, for display. */
const DISPLAY_PREFIX_CHARS = 8;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Largest multiple of 62 that fits in a byte. Bytes at or above it are discarded. */
const REJECTION_CEILING = 248;

export type KeyMode = "live" | "test";

export interface GeneratedKey {
  /** The full credential. Show once, then drop it. */
  token: string;
  keyPrefix: string;
  keyLastFour: string;
  keyHash: string;
}

function randomBase62(length: number): string {
  const out: string[] = [];
  while (out.length < length) {
    const bytes = new Uint8Array(length - out.length + 8);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= REJECTION_CEILING) continue;
      out.push(BASE62.charAt(byte % 62));
      if (out.length === length) break;
    }
  }
  return out.join("");
}

export function modePrefix(mode: KeyMode): string {
  return mode === "live" ? LIVE_PREFIX : TEST_PREFIX;
}

/**
 * Hash the *whole* token, prefix included, not just the random tail.
 *
 * That way ask_live_X and ask_test_X are different credentials even if the
 * random part were ever to collide, and a stored hash can never be replayed
 * against the other mode.
 */
export async function hashApiKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function generateApiKey(mode: KeyMode): Promise<GeneratedKey> {
  const secret = randomBase62(SECRET_LENGTH);
  const token = modePrefix(mode) + secret;
  return {
    token,
    keyPrefix: modePrefix(mode) + secret.slice(0, DISPLAY_PREFIX_CHARS),
    keyLastFour: secret.slice(-4),
    keyHash: await hashApiKey(token),
  };
}

/**
 * Constant-time string compare.
 *
 * Lookup is by unique-indexed hash, so this runs on two values we already
 * believe are equal - it is the defense-in-depth final compare 15.3 asks for,
 * not the primary check. Length is compared first and leaks only length, which
 * is fixed for every hash we produce.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function isApiKeyToken(token: string): boolean {
  return token.startsWith(LIVE_PREFIX) || token.startsWith(TEST_PREFIX);
}

export function keyMode(token: string): KeyMode | null {
  if (token.startsWith(LIVE_PREFIX)) return "live";
  if (token.startsWith(TEST_PREFIX)) return "test";
  return null;
}

/**
 * Read the bearer token from the Authorization header.
 *
 * Returns null rather than throwing: the caller decides whether an absent
 * credential is a 401 or an anonymous route.
 */
export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, ...rest] = header.trim().split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer") return null;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : null;
}

/** Query parameter names that would carry a credential if someone misread the docs. */
const CREDENTIAL_PARAM_NAMES = new Set([
  "api_key",
  "apikey",
  "access_token",
  "accesstoken",
  "auth_token",
  "authtoken",
  "bearer",
  "token",
]);

/**
 * Detect a credential in the query string.
 *
 * 16.4 says keys are never *accepted* there. Simply not reading them would
 * satisfy that literally, but a key that reached us in a URL has already been
 * written to Cloudflare's access logs and the caller's history - it is burned.
 * Failing loudly is the only response that gets it rotated, so we reject the
 * request instead of quietly serving it as anonymous.
 *
 * Matching is on parameter name *or* on a value carrying our own key prefix, so
 * an unusually-named parameter still trips it. The value itself is never
 * returned or logged.
 */
export function hasCredentialInQuery(url: URL): boolean {
  for (const [name, value] of url.searchParams) {
    if (CREDENTIAL_PARAM_NAMES.has(name.toLowerCase())) return true;
    if (isApiKeyToken(value)) return true;
  }
  return false;
}
