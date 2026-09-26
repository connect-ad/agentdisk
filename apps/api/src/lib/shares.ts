/**
 * Shared vocabulary for public share links — 05 PART 12.4.
 *
 * Pure helpers only, so the containment rule below can be tested without a
 * database, a Worker or a presigned URL in sight.
 */

import { validationError } from "./errors";
import { randomSecret, sha256Hex, timingSafeEqual } from "./keys";
import { normalizePrefix } from "../auth/scopes";

/** 12.4's cap. Both the default and the ceiling are seven days. */
export const MAX_SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_SHARE_TTL_MS = MAX_SHARE_TTL_MS;

/**
 * How long the R2 URL behind a share is good for.
 *
 * Nothing to do with the share's own lifetime: the public route mints one of
 * these per hit, which is exactly what makes revocation possible. A share that
 * has been deleted stops working immediately, even though a URL handed out a
 * minute earlier stays valid for its remaining hour. That residual window is
 * the price of not being in the byte path, and it is bounded.
 */
export const SHARE_DOWNLOAD_TTL_SECONDS = 60 * 60;

/**
 * Slack on the ceiling, so that asking for "seven days from now" is not a
 * race against a clock the caller cannot see.
 *
 * `now` here is `ctx.now`, captured before any I/O — and a Workers clock only
 * advances on I/O, so on a warm isolate it reads the *previous* request's
 * time. A caller who computes `theirNow + 7 days` is therefore compared
 * against a ceiling built from a timestamp in the past, and is refused for
 * being honest. The dashboard now omits the field entirely for its seven-day
 * preset, but every API caller writing the obvious thing hits this, so the
 * tolerance belongs here rather than only in one client.
 *
 * A minute does not weaken a seven-day policy: 12.4's cap exists to bound how
 * long bytes stay public, and it still does to within 0.01%.
 */
const EXPIRY_GRACE_MS = 60 * 1000;

export function resolveExpiry(requested: number | undefined, now: number): number {
  if (requested === undefined) return now + DEFAULT_SHARE_TTL_MS;
  if (requested <= now) {
    throw validationError("expiresAt must be in the future.");
  }
  if (requested > now + MAX_SHARE_TTL_MS + EXPIRY_GRACE_MS) {
    throw validationError("A share link cannot last longer than 7 days.");
  }
  // Never stored past the real ceiling, however it arrived. The grace decides
  // what is accepted, not what is granted.
  return Math.min(requested, now + MAX_SHARE_TTL_MS);
}

/**
 * Is this file path inside this shared folder?
 *
 * Segment boundaries, never `startsWith`. "/reports" must not match
 * "/reports-private/secrets.md" — the identical bug class `scopeAllowsPath`
 * exists to solve, which is why the prefix is normalized by that module's own
 * function rather than by a second definition of the same idea here.
 */
export function pathIsInside(candidate: string, folder: string): boolean {
  const prefix = normalizePrefix(folder);
  if (prefix === "") return true;
  return candidate.startsWith(`${prefix}/`);
}

/** The raw token and the hash the lookup index uses. */
export async function mintShareToken(): Promise<{ token: string; tokenHash: string }> {
  const token = randomSecret(32);
  return { token, tokenHash: await sha256Hex(token) };
}

export function shareUrl(dashboardUrl: string | undefined, token: string): string | null {
  if (!dashboardUrl) return null;
  return `${dashboardUrl.replace(/\/+$/, "")}/s/${encodeURIComponent(token)}`;
}

/**
 * Share-link passwords. Bounded above so a megabyte "password" cannot buy a
 * megabyte of PBKDF2 work per request, and below so the rate limit on wrong
 * guesses is protecting something worth the name.
 */
export const SHARE_PASSWORD_MIN = 6;
export const SHARE_PASSWORD_MAX = 128;

/**
 * PBKDF2-SHA256, because it is the password KDF Web Crypto actually has.
 * 100,000 is the most iterations the Workers runtime will run; the count is
 * stored in the value, so raising it later leaves existing links working.
 */
const PASSWORD_ITERATIONS = 100_000;
const PASSWORD_SCHEME = "pbkdf2-sha256";

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function hashSharePassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, PASSWORD_ITERATIONS);
  return `${PASSWORD_SCHEME}$${PASSWORD_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** False for a wrong password and for a stored value this code cannot read. */
export async function verifySharePassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, expected] = stored.split("$");
  const count = Number(iterations);
  if (scheme !== PASSWORD_SCHEME || !Number.isInteger(count) || !salt || !expected) return false;
  if (password.length > SHARE_PASSWORD_MAX) return false;
  const actual = toBase64(await derive(password, fromBase64(salt), count));
  return timingSafeEqual(actual, expected);
}

/**
 * The `Content-Disposition` a shared file is served with: always `attachment`.
 *
 * A share link is opened by somebody with no account here, and an inline
 * render of an uploaded `.html` or `.svg` runs whatever it contains on R2's
 * origin in a stranger's browser. Text files rendering in the tab was the
 * visible symptom; the forced download is the fix for both. The `download`
 * attribute on the page's anchor cannot do this — browsers ignore it for a
 * cross-origin URL, which a presigned R2 URL always is.
 *
 * `filename` is the ASCII fallback, `filename*` the real name (RFC 6266).
 */
export function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_") || "download";
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
