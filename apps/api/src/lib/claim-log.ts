/**
 * Every touch of a claim link, recorded.
 *
 * This exists because the preview stopped explaining itself. A claimed link now
 * answers exactly as an unknown one does — the route takes no credential, so a
 * distinguishable answer told anybody guessing tokens which guesses named a
 * real workspace. That was the right trade, but it left a support engineer with
 * nothing to say when somebody asks why their link does not work. This is what
 * they read instead.
 *
 * ── What is stored, and what deliberately is not ───────────────────────────
 * Only the token's **hash**, never the token. The same rule as
 * `workspaces.claim_token_hash`, and the reason somebody can confirm *which*
 * link was used and can never use it themselves.
 *
 * No foreign keys, for the same reason `pending_deletions` has none: the
 * workspace a row names may already be deleted, and the row is worth most
 * precisely then.
 *
 * IP addresses of unauthenticated visitors are personal data, so these rows are
 * trimmed after 90 days by the same sweep that erases bytes. Keeping them
 * forever because logging is cheap is how a log becomes a liability.
 */

import { newId } from "./ids";

export type ClaimOutcome =
  | "previewed"
  | "claimed"
  | "already_claimed"
  | "expired"
  | "unknown_token";

/** 90 days. See the file header for why this is bounded at all. */
export const CLAIM_ATTEMPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface ClaimAttempt {
  tokenHash: string;
  workspaceId?: string | null;
  outcome: ClaimOutcome;
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Write one attempt. Never throws.
 *
 * A failure to record must not fail the claim. The person's workspace matters
 * more than our note of it, and an error thrown here would turn a successful
 * claim into a 500 *after* the merge had already happened — the one outcome
 * worse than a missing log line.
 *
 * The user agent is truncated rather than stored whole: it is a diagnostic, and
 * an unbounded client-supplied string in a table nobody reads is how a row gets
 * large enough to matter.
 */
export async function recordClaimAttempt(
  db: D1Database,
  entry: ClaimAttempt,
  now: number
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO claim_attempts
           (id, token_hash, workspace_id, outcome, user_id, ip, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        newId("claimAttempt", now),
        entry.tokenHash,
        entry.workspaceId ?? null,
        entry.outcome,
        entry.userId ?? null,
        entry.ip ?? null,
        entry.userAgent?.slice(0, 256) ?? null,
        now
      )
      .run();
  } catch (err) {
    console.log(
      JSON.stringify({
        level: "warn",
        message: "claim attempt log failed",
        outcome: entry.outcome,
        reason: err instanceof Error ? err.message : String(err),
      })
    );
  }
}

/**
 * What a request tells us about who is asking.
 *
 * `cf-connecting-ip` is the one address header Cloudflare sets itself and a
 * client cannot forge. Anything else would put a forgeable value in a log whose
 * whole purpose is accountability, which is worse than an honest blank.
 */
export function callerOf(request: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: request.headers.get("cf-connecting-ip"),
    userAgent: request.headers.get("user-agent"),
  };
}
