/**
 * Quota checks - 02 PART 6.5, run in the authorization middleware before any
 * business logic, returning 429 LIMIT_EXCEEDED naming the dimension that was hit.
 *
 * Scope note, and it is two scopes rather than one. **Storage and file count
 * are the subscription's allowance and belong to the billing account**: one
 * card, one plan, many workspaces, so they are checked against the
 * organization's totals. Counting them per workspace - which is what this did
 * before migration 0017 - meant an account on Pro with five workspaces held
 * five times the Pro allowance, and that the way to get more room was to press
 * "New workspace", which is free. **Egress and requests stay per workspace**,
 * because they are period counters that reset on the workspace's own
 * `period_reset_at` and there is no account-level period to reset them on;
 * both are `UNLIMITED` on every paid plan, so the distinction currently only
 * bites a sandbox, which is alone in its organization anyway.
 *
 * All of it still enforces against denormalized counters, maintained by
 * whoever writes - the storage layer increments storage/file counts at both
 * levels in one batch, the rate limiter increments requests. What this file
 * must not do is pretend to enforce a dimension nobody is measuring.
 */

import { ApiError } from "./errors";
import type { PlanLimits } from "./plans";
import type { AccountUsage, WorkspaceRow } from "../db/types";

export type QuotaDimension = "storage" | "files" | "egress" | "requests" | "agents" | "keys";

export interface QuotaDemand {
  /** Bytes this request is about to add to stored size. */
  bytes?: number;
  /** Files this request is about to create. */
  files?: number;
  /** Bytes this request is about to account as egress. */
  egressBytes?: number;
}

function exceeded(
  limit: QuotaDimension,
  message: string,
  used: number,
  max: number
): ApiError {
  return new ApiError("LIMIT_EXCEEDED", message, { details: { limit, used, max } });
}

/**
 * Period counters (egress, requests) reset on a schedule. If the reset moment
 * has passed but the reconciliation job has not run yet, the stored counter is
 * stale and must read as zero - otherwise a workspace that hit its monthly cap
 * stays locked out past the end of the month, which is the kind of bug that
 * only shows up in production on the first of the month.
 */
function periodCounter(value: number, workspace: WorkspaceRow, now: number): number {
  return now >= workspace.period_reset_at ? 0 : value;
}

/**
 * Whether an unpaid account may still do this (14 PART 29.4).
 *
 * Writes stop, reads continue. Somebody whose card expired must still be able
 * to list and download their own files - locking them out of their data to
 * chase a payment turns a billing problem into a support crisis and a
 * reputation for holding data hostage. It also costs nothing to allow: reads
 * are the cheap half.
 *
 * Reported as a limit rather than an authorization failure, deliberately. The
 * credential is fine and the caller is who they say they are; what has run out
 * is the account's standing, which is the same category of thing as running out
 * of storage and reads better in a client that already handles that.
 */
function assertBillingAllowsWrite(billingStatus: string, demand: QuotaDemand): void {
  if (billingStatus === "active") return;

  const writing =
    (demand.bytes !== undefined && demand.bytes > 0) ||
    (demand.files !== undefined && demand.files > 0);
  if (!writing) return;

  throw new ApiError("LIMIT_EXCEEDED", refusal(billingStatus), {
    details: { limit: "billing", status: billingStatus },
  });
}

/**
 * What to tell somebody whose account cannot write.
 *
 * Each one names the state, says plainly that nothing has been deleted, and
 * gives the action that fixes it. The deadline is deliberately relative rather
 * than an exact date: this message is built on the request path, which does not
 * carry the period end, and the dashboard already shows the real date from
 * `GET /v1/billing`. A wrong date here would be worse than no date.
 */
function refusal(billingStatus: string): string {
  switch (billingStatus) {
    case "past_due":
      // Day 0 of the ladder, and the state most accounts that reach this point
      // are actually in. Names the likely cause, because "an unpaid invoice"
      // sounds like a dispute and it is almost always an expired card.
      return (
        "We could not take payment for this account — usually an expired or replaced card. " +
        "New uploads are paused; everything you have stored is still readable and " +
        "downloadable. Update the payment method on the billing page and it resumes " +
        "immediately."
      );
    case "expired":
      // Day +7. The card never cleared and the deletion clock has started.
      return (
        "Payment for this account could not be collected and the 7-day grace period has " +
        "passed. New uploads are paused and the account's data is scheduled for deletion; " +
        "nothing has been removed yet, and starting a plan again cancels it."
      );
    default:
      return "This account's subscription has ended. New uploads are paused; your files remain readable.";
  }
}

export function assertWithinQuota(
  workspace: WorkspaceRow & AccountUsage,
  limits: PlanLimits,
  demand: QuotaDemand,
  now: number,
  billingStatus = "active"
): void {
  // Before any counter. An account that may not write at all should be told
  // that, not told it is near a storage limit it will never be allowed to fill.
  assertBillingAllowsWrite(billingStatus, demand);

  const requests = periodCounter(workspace.requests_period, workspace, now);
  if (requests >= limits.requestsPerPeriod) {
    throw exceeded(
      "requests",
      "This workspace has used its request allowance for the current period.",
      requests,
      limits.requestsPerPeriod
    );
  }

  // Account, not workspace. The message says "account" too: a person told
  // their *workspace* is full, on a screen showing that workspace holding a
  // fraction of the plan's storage, would reasonably conclude the product is
  // broken - and the action that fixes it is on the billing page, not this
  // workspace's.
  if (demand.bytes !== undefined && demand.bytes > 0) {
    const projected = workspace.org_storage_bytes_used + demand.bytes;
    if (projected > limits.storageBytes) {
      throw exceeded(
        "storage",
        "This account has reached its storage limit. Upgrade to add more.",
        workspace.org_storage_bytes_used,
        limits.storageBytes
      );
    }
  }

  if (demand.files !== undefined && demand.files > 0) {
    const projected = workspace.org_file_count + demand.files;
    if (projected > limits.fileCount) {
      throw exceeded(
        "files",
        "This account has reached its file-count limit. Upgrade to add more.",
        workspace.org_file_count,
        limits.fileCount
      );
    }
  }

  if (demand.egressBytes !== undefined && demand.egressBytes > 0) {
    const egress = periodCounter(workspace.egress_bytes_period, workspace, now);
    if (egress + demand.egressBytes > limits.egressBytesPerPeriod) {
      throw exceeded(
        "egress",
        "This workspace has used its egress allowance for the current period.",
        egress,
        limits.egressBytesPerPeriod
      );
    }
  }
}

/** Per-file size cap - checked before a presigned URL is ever issued (06 PART 16.13). */
export function assertFileSizeAllowed(sizeBytes: number, limits: PlanLimits): void {
  if (sizeBytes > limits.maxFileBytes) {
    throw new ApiError("PAYLOAD_TOO_LARGE", "That file is larger than this plan allows.", {
      details: { limit: "storage", used: sizeBytes, max: limits.maxFileBytes },
    });
  }
}
