/**
 * Shared vocabulary for public share links — 05 PART 12.4.
 *
 * Pure helpers only, so the containment rule below can be tested without a
 * database, a Worker or a presigned URL in sight.
 */

import { validationError } from "./errors";
import { randomSecret, sha256Hex } from "./keys";
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

export function resolveExpiry(requested: number | undefined, now: number): number {
  if (requested === undefined) return now + DEFAULT_SHARE_TTL_MS;
  if (requested <= now) {
    throw validationError("expiresAt must be in the future.");
  }
  if (requested > now + MAX_SHARE_TTL_MS) {
    throw validationError("A share link cannot last longer than 7 days.");
  }
  return requested;
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
