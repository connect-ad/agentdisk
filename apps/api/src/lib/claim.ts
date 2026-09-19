/**
 * Shared vocabulary for workspace claiming.
 *
 * Pure helpers and the two constants that must not be duplicated, because the
 * same numbers are read by the write path, the claim page and the expiry sweep.
 *
 * ---
 *
 * **A note on `claimUrl`, because the design prompt asks for something the
 * storage model forbids.**
 *
 * The brief for the sandbox quota warning specifies a `claimUrl` carrying the
 * raw token, attached to every warned write. It cannot: the same brief - and
 * `api_keys.key_hash` before it - requires that only the SHA-256 of a claim
 * token is ever persisted. A token that can be rebuilt on an arbitrary request
 * is a token that was stored in cleartext, which is exactly the property the
 * hashing exists to prevent. The two requirements are mutually exclusive and
 * hash-only storage is the half worth keeping, so:
 *
 *  - The **provisioning response** carries the full `claimUrl`. That is the one
 *    moment the raw token exists in memory, and it is already the response
 *    documented as show-once.
 *  - The **quota warning** carries `claimEntryUrl` - the claim page with no
 *    token - plus the workspace ID, and says in words that the link was issued
 *    at provisioning time. An agent that kept its provisioning response has the
 *    real link; one that did not cannot be handed it again by us, and pretending
 *    otherwise would mean storing the secret.
 *
 * Minting a *fresh* token when the warning fires was considered and rejected:
 * it would be a database write on a read-shaped path, and it would silently
 * invalidate the link a person may already be holding.
 */

/**
 * Fraction of a sandbox limit at which a write starts warning instead of
 * passing silently. Below the hard block, which is still 100%.
 *
 * Lives here, is read by the one call site that also performs the hard block,
 * and is exported so tests assert the boundary rather than a copy of it.
 * `backlog/017` is the cautionary tale: this product already shipped an
 * 80%/95% warning that existed only in the dashboard's own arithmetic, was
 * never wired to the request path, and therefore lied.
 */
export const SANDBOX_WARNING_FRACTION = 0.8;

/**
 * How long an unclaimed sandbox survives before the sweep may reclaim it.
 *
 * Lives here rather than in the job so the claim preview and the quota warning
 * can quote the same deadline the sweep will actually act on. A page that tells
 * somebody "3 days left" from its own arithmetic, while the job works to a
 * different number, is the drift `backlog/017` is about.
 *
 * Shorter than CLAIM_TOKEN_TTL_MS (30 days) on purpose - see the note there.
 */
export const UNCLAIMED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The dimensions a sandbox warning can be about. Storage and files are the capped pair. */
export type SandboxWarningDimension = "storage" | "files";

export interface SandboxQuotaWarning {
  code: "SANDBOX_QUOTA_WARNING";
  dimension: SandboxWarningDimension;
  /** Whole percent of the sandbox limit this write lands the workspace at. */
  usedPercent: number;
  used: number;
  limit: number;
  message: string;
  workspaceId: string;
  /**
   * The claim page without a token - see the file header. The tokenised link
   * was returned once, at provisioning.
   */
  claimEntryUrl: string | null;
  /** Days until the unclaimed sweep is eligible to delete this workspace. */
  deletesInDays: number | null;
}

/** The tokenised claim link. Only ever built where the raw token legitimately exists. */
export function claimUrl(dashboardUrl: string | undefined, token: string): string | null {
  if (!dashboardUrl) return null;
  return `${dashboardUrl.replace(/\/+$/, "")}/claim/${encodeURIComponent(token)}`;
}

/** The claim page with no token, for a caller that must supply its own link. */
export function claimEntryUrl(dashboardUrl: string | undefined): string | null {
  if (!dashboardUrl) return null;
  return `${dashboardUrl.replace(/\/+$/, "")}/claim`;
}

export interface SandboxWarningInput {
  workspaceId: string;
  /** Usage *after* the write that is about to succeed. */
  projected: { bytes: number; files: number };
  limits: { storageBytes: number; fileCount: number };
  dashboardUrl: string | undefined;
  /** When the unclaimed sweep becomes eligible to delete this workspace, or null. */
  deletesAt: number | null;
  now: number;
}

/**
 * The warning for a write that is allowed but close to the cap, or null.
 *
 * Computed from the *projected* usage - the state the caller is about to be in,
 * not the one they were in when they asked - because a warning describing the
 * previous request is a warning one write late. The single dimension reported
 * is whichever is proportionally fuller, so a workspace near both caps gets one
 * clear number rather than two competing ones.
 */
export function sandboxQuotaWarning(input: SandboxWarningInput): SandboxQuotaWarning | null {
  const byStorage = input.limits.storageBytes > 0
    ? input.projected.bytes / input.limits.storageBytes
    : 0;
  const byFiles = input.limits.fileCount > 0
    ? input.projected.files / input.limits.fileCount
    : 0;

  const storageWins = byStorage >= byFiles;
  const fraction = storageWins ? byStorage : byFiles;

  // At or over 100% the hard block has already thrown, so reaching here with a
  // full workspace would mean the two disagreed. Staying silent is the safe
  // reading: a "warning" on a write that was actually refused would be noise.
  if (fraction < SANDBOX_WARNING_FRACTION || fraction > 1) return null;

  const dimension: SandboxWarningDimension = storageWins ? "storage" : "files";
  const used = storageWins ? input.projected.bytes : input.projected.files;
  const limit = storageWins ? input.limits.storageBytes : input.limits.fileCount;
  const usedPercent = Math.round(fraction * 100);

  const deletesInDays =
    input.deletesAt === null
      ? null
      : Math.max(0, Math.ceil((input.deletesAt - input.now) / (24 * 60 * 60 * 1000)));

  const fate =
    deletesInDays === null
      ? "Claim it to keep it."
      : deletesInDays === 0
        ? "It is due to be deleted today unless it is claimed."
        : `It will be deleted in ${deletesInDays} day${deletesInDays === 1 ? "" : "s"} if it is never claimed.`;

  return {
    code: "SANDBOX_QUOTA_WARNING",
    dimension,
    usedPercent,
    used,
    limit,
    message:
      `This unclaimed workspace is at ${usedPercent}% of its temporary ` +
      `${dimension === "storage" ? "storage" : "file-count"} limit. ${fate}`,
    workspaceId: input.workspaceId,
    claimEntryUrl: claimEntryUrl(input.dashboardUrl),
    deletesInDays,
  };
}
