/**
 * The 30-day sweep behind admin-initiated deletion — 32 PART 7 and 11.
 *
 * `DELETE /v1/admin/users/:id` and `DELETE /v1/admin/workspaces/:id` set a
 * timestamp and stop. Nothing irreversible happens inline, on purpose: a admin
 * member deleting somebody ELSE's data is exactly where the absence of a grace
 * period hurts most, and the restore endpoints have to have something left to
 * restore. This is the job that eventually makes it real.
 *
 * ── It reports by default, and that default is not timidity ────────────────
 * `dryRun` defaults to true and only `ADMIN_PURGE_ENABLED = "true"` turns on
 * real deletion — the same shape as `expireUnclaimedWorkspaces`, for the same
 * reason it was needed there. Dev already holds weeks of test data, and a sweep
 * with no "only what was deleted after this shipped" guard would take all of it
 * on the first tick. Run it dark for a full window, read the candidate logs,
 * and only then enable it.
 *
 * ── What it does NOT do ────────────────────────────────────────────────────
 * It never touches an organization with a live Stripe customer and an
 * uncancelled subscription. The deletion endpoint already blocks on that, but a
 * subscription can be created — or a block lifted — in the thirty days between
 * the two, and a cascade is not the place to discover it. Such a candidate is
 * reported as skipped and stays deleted-but-present until somebody resolves the
 * billing.
 *
 * It also never deletes a `users` row. The row is what an `audit_events` actor
 * id resolves to; removing it would leave every historical action attributed to
 * nothing. The PII is scrubbed and the row is kept as a tombstone.
 */

import { deleteWorkspaceCascade } from "../db/workspace-cascade";

/** Thirty days, in ms. The window both delete endpoints promise. */
export const ADMIN_PURGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface AdminPurgeResult {
  dryRun: boolean;
  /** Workspaces past their window, whether or not anything was done to them. */
  workspaceCandidates: number;
  workspacesPurged: number;
  objectsDeleted: number;
  /** Users past their window. */
  userCandidates: number;
  usersScrubbed: number;
  /** Skipped because an organization still has live billing. */
  skippedForBilling: number;
  failed: number;
}

/**
 * A tombstoned address.
 *
 * `users.email` is NOT NULL UNIQUE, so the scrub cannot blank it — and should
 * not, because releasing the address would let somebody else register it and
 * inherit nothing but the confusion. The `.invalid` TLD is RFC 2606's, and can
 * never resolve or receive mail.
 */
function tombstoneEmail(userId: string): string {
  return `deleted-${userId}@deleted.invalid`;
}

export async function purgeAdminDeleted(
  db: D1Database,
  files: R2Bucket,
  now: number,
  dryRun = true
): Promise<AdminPurgeResult> {
  const cutoff = now - ADMIN_PURGE_WINDOW_MS;
  const result: AdminPurgeResult = {
    dryRun,
    workspaceCandidates: 0,
    workspacesPurged: 0,
    objectsDeleted: 0,
    userCandidates: 0,
    usersScrubbed: 0,
    skippedForBilling: 0,
    failed: 0,
  };

  /* ------------------------------ workspaces ----------------------------- */

  const workspaces = await db
    .prepare(
      `SELECT w.id, w.name, w.org_id AS orgId,
              o.stripe_customer_id AS stripeCustomerId, o.billing_status AS billingStatus
         FROM workspaces w
         JOIN organizations o ON o.id = w.org_id
        WHERE w.deleted_at IS NOT NULL AND w.deleted_at <= ?`
    )
    .bind(cutoff)
    .all<{
      id: string;
      name: string;
      orgId: string;
      stripeCustomerId: string | null;
      billingStatus: string;
    }>();

  for (const workspace of workspaces.results ?? []) {
    result.workspaceCandidates += 1;

    const liveBilling =
      workspace.stripeCustomerId !== null &&
      workspace.billingStatus !== "canceled" &&
      workspace.billingStatus !== "cancelled";

    if (liveBilling) {
      result.skippedForBilling += 1;
      console.log(
        JSON.stringify({
          level: "warn",
          message: "admin purge skipped: live billing",
          workspaceId: workspace.id,
          orgId: workspace.orgId,
          billingStatus: workspace.billingStatus,
        })
      );
      continue;
    }

    if (dryRun) {
      console.log(
        JSON.stringify({
          level: "info",
          message: "admin purge candidate (workspace)",
          workspaceId: workspace.id,
          name: workspace.name,
        })
      );
      continue;
    }

    try {
      const cascade = await deleteWorkspaceCascade(db, files, workspace.id);
      result.objectsDeleted += cascade.objectsDeleted;
      result.workspacesPurged += 1;
    } catch (err) {
      // A failure leaves the workspace intact and the operation retryable,
      // which is the better half of the trade the cascade already makes.
      result.failed += 1;
      console.log(
        JSON.stringify({
          level: "error",
          message: "admin purge failed (workspace)",
          workspaceId: workspace.id,
          reason: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }

  /* --------------------------------- users -------------------------------- */

  const users = await db
    .prepare(
      `SELECT u.id, u.email,
              (SELECT COUNT(*) FROM organizations o
                 JOIN memberships m ON m.org_id = o.id AND m.user_id = u.id AND m.role = 'owner'
                WHERE o.stripe_customer_id IS NOT NULL
                  AND o.billing_status NOT IN ('canceled', 'cancelled')) AS liveBilling
         FROM users u
        WHERE u.deleted_at IS NOT NULL AND u.deleted_at <= ?`
    )
    .bind(cutoff)
    .all<{ id: string; email: string; liveBilling: number }>();

  for (const user of users.results ?? []) {
    result.userCandidates += 1;

    if (user.liveBilling > 0) {
      result.skippedForBilling += 1;
      console.log(
        JSON.stringify({
          level: "warn",
          message: "admin purge skipped: live billing",
          userId: user.id,
        })
      );
      continue;
    }

    if (dryRun) {
      console.log(
        JSON.stringify({
          level: "info",
          message: "admin purge candidate (user)",
          userId: user.id,
        })
      );
      continue;
    }

    try {
      // The row survives as a tombstone. It is what an audit_events actor id
      // resolves to, and deleting it would leave every historical action this
      // person took attributed to nothing at all.
      await db
        .prepare(
          `UPDATE users
              SET email = ?, firebase_uid = NULL, email_verified_at = NULL, updated_at = ?
            WHERE id = ? AND deleted_at IS NOT NULL`
        )
        .bind(tombstoneEmail(user.id), now, user.id)
        .run();
      result.usersScrubbed += 1;
    } catch (err) {
      result.failed += 1;
      console.log(
        JSON.stringify({
          level: "error",
          message: "admin purge failed (user)",
          userId: user.id,
          reason: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }

  return result;
}
