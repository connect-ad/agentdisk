/**
 * Removing the bytes a hard-deleted workspace left behind — designed 22 Sept 2026.
 *
 * The workspace, its keys, its agents, its webhooks and its share links are
 * destroyed in the request that deletes it. This is the other half: the R2
 * objects, seven days later.
 *
 * **Objects before rows**, matching `jobs/purge.ts`. The row is the only record
 * that an object exists, so losing it first orphans bytes nothing can ever find
 * again. A failure between the two leaves a row whose object is already gone,
 * which the next run resolves for free — see below.
 *
 * **Already-gone is success, not failure.** R2's delete is idempotent; the
 * desired state is "no object", and a retry that finds nothing has reached it.
 *
 * **A per-file failure does not fail the run.** It increments `attempts` and
 * writes `last_error`, leaving the row for next time. A row whose `attempts`
 * climbs without bound is visible in the console listing, which is where that
 * belongs: it is an operator's judgement call, not a cron's.
 */

import { newId } from "../lib/ids";
import { CLAIM_ATTEMPT_RETENTION_MS } from "../lib/claim-log";
import { deleteFirebaseUser, type FirebaseAdminConfig } from "../auth/firebase-admin";
import { sendAccountErasedEmail, type EmailConfig } from "../lib/email";

/** R2 accepts up to 1000 keys in one delete. */
const R2_DELETE_CHUNK = 1000;

/** Bounded so one run cannot exceed a Worker's CPU or wall-clock budget. */
const DEFAULT_LIMIT = 500;

/**
 * How long past its due date an account keeps waiting for its final notice to
 * be delivered before the release goes ahead without it.
 *
 * The notice is sent BEFORE the address is released, and a failed send holds
 * the release for that hour - the address was kept for seven days precisely so
 * this message could reach it. But an address that will never accept mail (the
 * domain is gone, the provider rejects the sender) must not hold a person's
 * identity in our systems forever; that would invert the promise the sweep
 * exists to keep. Two days of hourly retries is long past any transient outage.
 */
export const ERASURE_NOTICE_GRACE_MS = 48 * 60 * 60 * 1000;

export interface SweepResult {
  examined: number;
  objectsDeleted: number;
  rowsDeleted: number;
  bytesFreed: number;
  failed: number;
  /** Accounts whose Firebase identity and email address were both released. */
  identitiesReleased: number;
  /** True when the identity pass was skipped for want of a Firebase config. */
  identitySkipped: boolean;
  /** Final "your account has been deleted" notices delivered this run. */
  erasureEmailsSent: number;
  /** Notices that could not be sent; each held its account's release for this run. */
  erasureEmailsFailed: number;
  /** True when no email binding was available, so releases went ahead unannounced. */
  emailSkipped: boolean;
  /** Claim-attempt rows removed past their 90-day retention. */
  claimAttemptsTrimmed: number;
  dryRun: boolean;
  /** The `job_runs` row this write produced, so a caller can link to it. */
  runId: string;
}

export interface SweepOptions {
  /**
   * Defaults to TRUE, exactly as `expireUnclaimedWorkspaces` does, and for the
   * same reason rather than out of symmetry.
   *
   * Building and testing this feature queues rows whose due dates fall during
   * the work, and dev already holds weeks of test data. The first deploy
   * carrying a working sweep would, without a flag, destroy all of it on the
   * next hourly tick - unattended, with no undo and no second copy of the
   * bytes. With the flag that deploy prints a list instead.
   */
  dryRun?: boolean;
  /** Take rows that are not yet due. super_admin only at the route. */
  force?: boolean;
  limit?: number;
  trigger?: "cron" | "admin";
  actorId?: string | null;
  actorEmail?: string | null;
  /**
   * What the identity pass needs. Absent - or present with a null config -
   * skips that half entirely and says so in the result.
   *
   * Skipping is the only safe response to a missing Firebase config. Releasing
   * the email address while Firebase still holds the identity would free the
   * address in our database and leave it claimed in theirs, so the person's
   * next signup fails on EMAIL_EXISTS with nothing in our data explaining why.
   * The two are released together or not at all.
   */
  identity?: {
    config: FirebaseAdminConfig | null;
    kv: KVNamespace;
    /** Tests only: stands in for `deleteFirebaseUser`, which needs a live project. */
    deleteUser?: typeof deleteFirebaseUser;
  };
  /**
   * How the final notice is sent. Absent or null skips the notice and says so
   * in the result; the release still happens. Deployments without the binding
   * are test environments, and a person's identity must not be held hostage
   * to a message that no configuration can send.
   */
  email?: EmailConfig | null;
}

interface PendingRow {
  file_id: string;
  r2_object_key: string;
  size_bytes: number;
  attempts: number;
}

/**
 * Whether real deletion is switched on for this deployment.
 *
 * The exact string, so an unset, empty or misspelled value is safe. Same shape
 * as SANDBOX_EXPIRY_ENABLED and ADMIN_PURGE_ENABLED before it.
 */
export function pendingDeletionEnabled(env: { PENDING_DELETION_ENABLED?: string }): boolean {
  return env.PENDING_DELETION_ENABLED === "true";
}

export async function sweepPendingDeletions(
  db: D1Database,
  files: R2Bucket,
  now: number,
  options: SweepOptions = {}
): Promise<SweepResult> {
  const dryRun = options.dryRun ?? true;
  const force = options.force ?? false;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const runId = newId("jobRun", now);

  await db
    .prepare(
      `INSERT INTO job_runs
         (id, job, trigger, actor_id, actor_email, dry_run, started_at)
       VALUES (?, 'pending_deletions', ?, ?, ?, ?, ?)`
    )
    .bind(
      runId,
      options.trigger ?? "cron",
      options.actorId ?? null,
      options.actorEmail ?? null,
      dryRun ? 1 : 0,
      now
    )
    .run();

  const result: SweepResult = {
    examined: 0,
    objectsDeleted: 0,
    rowsDeleted: 0,
    bytesFreed: 0,
    failed: 0,
    identitiesReleased: 0,
    identitySkipped: false,
    erasureEmailsSent: 0,
    erasureEmailsFailed: 0,
    emailSkipped: false,
    claimAttemptsTrimmed: 0,
    dryRun,
    runId,
  };

  try {
    // Oldest first, so a backlog drains in the order it accumulated rather than
    // starving the earliest rows forever.
    const candidates = await db
      .prepare(
        force
          ? `SELECT file_id, r2_object_key, size_bytes, attempts
               FROM pending_deletions ORDER BY due_at ASC LIMIT ?`
          : `SELECT file_id, r2_object_key, size_bytes, attempts
               FROM pending_deletions WHERE due_at <= ? ORDER BY due_at ASC LIMIT ?`
      )
      .bind(...(force ? [limit] : [now, limit]))
      .all<PendingRow>();

    const rows = candidates.results ?? [];
    result.examined = rows.length;

    if (dryRun) {
      // A run you cannot see is not a report, so a dry run still counts what it
      // would have achieved and still writes its job_runs row.
      result.objectsDeleted = rows.length;
      result.bytesFreed = rows.reduce((sum, row) => sum + (row.size_bytes ?? 0), 0);
      console.log(
        JSON.stringify({
          level: "info",
          message: "pending deletion candidates (dry run)",
          runId,
          examined: rows.length,
          bytes: result.bytesFreed,
          keys: rows.slice(0, 20).map(row => row.r2_object_key),
        })
      );
    } else {
      const done: PendingRow[] = [];

      for (let i = 0; i < rows.length; i += R2_DELETE_CHUNK) {
        const chunk = rows.slice(i, i + R2_DELETE_CHUNK);
        try {
          await files.delete(chunk.map(row => row.r2_object_key));
          done.push(...chunk);
          result.objectsDeleted += chunk.length;
        } catch (err) {
          // The chunk failed as a unit and we cannot tell which key caused it,
          // so every row in it is charged one attempt and left for next time.
          result.failed += chunk.length;
          const message = err instanceof Error ? err.message : String(err);
          await db.batch(
            chunk.map(row =>
              db
                .prepare(
                  `UPDATE pending_deletions
                      SET attempts = attempts + 1, last_error = ?
                    WHERE file_id = ?`
                )
                .bind(message.slice(0, 500), row.file_id)
            )
          );
        }
      }

      // Rows only for objects that are actually gone.
      for (let i = 0; i < done.length; i += R2_DELETE_CHUNK) {
        const chunk = done.slice(i, i + R2_DELETE_CHUNK);
        await db.batch(
          chunk.map(row =>
            db.prepare(`DELETE FROM pending_deletions WHERE file_id = ?`).bind(row.file_id)
          )
        );
        result.rowsDeleted += chunk.length;
        result.bytesFreed += chunk.reduce((sum, row) => sum + (row.size_bytes ?? 0), 0);
      }
    }

    await releaseIdentities(
      db,
      now,
      dryRun,
      force,
      limit,
      options.identity,
      options.email ?? null,
      result
    );

    // The claim-attempt log's retention, trimmed by the sweep that already
    // runs. These rows hold IP addresses of unauthenticated visitors, so they
    // are bounded rather than kept because keeping them is cheap - ninety days
    // is long enough for the investigation the table exists for.
    if (!dryRun) {
      const trimmed = await db
        .prepare(`DELETE FROM claim_attempts WHERE created_at < ?`)
        .bind(now - CLAIM_ATTEMPT_RETENTION_MS)
        .run();
      result.claimAttemptsTrimmed = trimmed.meta.changes ?? 0;
    }

    await finish(db, runId, now, result, null);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finish(db, runId, now, result, message.slice(0, 500));
    throw err;
  }
}

/**
 * Free the email address, scrub what else identifies the person, and mark the
 * purge finished.
 *
 * Called only after the Firebase identity is gone, and every field moves
 * together: the address is released so the person can sign up again, the uid is
 * cleared so a retry cannot repeat a delete that already succeeded, the GitHub
 * id and the verification stamp go because they are still a piece of the person
 * (and `oauth_github_id` is UNIQUE, so a returning GitHub user would otherwise
 * collide exactly as the email used to), and `purge_after` is cleared so the
 * row reads as finished rather than perpetually due.
 *
 * Any membership still pointing at the row goes too. None should exist - the
 * closure removed them - but an invitation sent to the held address inside the
 * window used to create one, and a tombstone in a members list is the ghost
 * this line exists to prevent.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve or receive mail —
 * the same pattern `db/bootstrap.ts` uses for provisional sandbox owners. The
 * row itself survives as a tombstone for `audit_events.actor_id`.
 *
 * Exported so the round trip can be tested against the real statement: the
 * whole point is that `users.email NOT NULL UNIQUE` stops blocking that
 * address, and a test asserting a copy of this SQL would prove nothing.
 */
export async function releaseAddress(
  db: D1Database,
  userId: string,
  now: number
): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM memberships WHERE user_id = ?`).bind(userId),
    db
      .prepare(
        `UPDATE users
            SET email = ?, firebase_uid = NULL, oauth_github_id = NULL,
                email_verified_at = NULL, purge_after = NULL, updated_at = ?
          WHERE id = ?`
      )
      .bind(`deleted-${userId}@agentdisk.invalid`, now, userId),
  ]);
}

/**
 * Send the final notice, once.
 *
 * The claim is the UPDATE: only the caller whose statement changed a row sends,
 * so the hourly cron and the console's Run now cannot both deliver it. If the
 * send then fails, the claim is reverted so the next run tries again; the
 * address is untouched either way, because the caller has not released it yet.
 *
 * Returns false when nothing was sent and the caller should not proceed.
 */
async function sendFinalNotice(
  db: D1Database,
  email: EmailConfig,
  user: DueUser,
  now: number
): Promise<boolean> {
  const claimed = await db
    .prepare(`UPDATE users SET erasure_notified_at = ? WHERE id = ? AND erasure_notified_at IS NULL`)
    .bind(now, user.id)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) return true; // somebody else already sent it

  try {
    await sendAccountErasedEmail(email, {
      to: user.email,
      closedDate: new Date(user.deleted_at).toISOString().slice(0, 10),
    });
    return true;
  } catch (err) {
    await db
      .prepare(`UPDATE users SET erasure_notified_at = NULL WHERE id = ? AND erasure_notified_at = ?`)
      .bind(user.id, now)
      .run();
    console.log(
      JSON.stringify({
        level: "warn",
        message: "account erasure notice failed; release held",
        userId: user.id,
        reason: err instanceof Error ? err.message : String(err),
      })
    );
    return false;
  }
}

interface DueUser {
  id: string;
  firebase_uid: string;
  email: string;
  deleted_at: number;
  purge_after: number;
  erasure_notified_at: number | null;
}

/**
 * Release the identity and the email address of accounts past their window.
 *
 * Runs after the bytes, and its failures never stop them: the objects are the
 * expensive half and the half a customer actually asked for. An identity that
 * could not be deleted is retried on the next sweep, because `purge_after` is
 * only cleared once the deletion succeeded.
 *
 * **Both halves move together or neither does.** Scrubbing the address while
 * Firebase still holds the identity would release it here and leave it claimed
 * there, so the person's next signup fails on EMAIL_EXISTS with nothing on our
 * side to explain it. That is why a missing config skips rather than
 * part-completes.
 *
 * The scrubbed address uses `.invalid`, reserved by RFC 2606 so it can never
 * resolve or receive mail - the same pattern `db/bootstrap.ts` uses for
 * provisional sandbox owners.
 */
async function releaseIdentities(
  db: D1Database,
  now: number,
  dryRun: boolean,
  force: boolean,
  limit: number,
  identity: SweepOptions["identity"],
  email: EmailConfig | null,
  result: SweepResult
): Promise<void> {
  const due = await db
    .prepare(
      `SELECT id, firebase_uid, email, deleted_at, purge_after, erasure_notified_at
         FROM users
        WHERE purge_after IS NOT NULL
          AND purge_after <= ?
          AND deleted_at IS NOT NULL
          AND firebase_uid IS NOT NULL
        ORDER BY purge_after LIMIT ?`
    )
    .bind(force ? Number.MAX_SAFE_INTEGER : now, limit)
    .all<DueUser>();

  const rows = due.results ?? [];
  if (rows.length === 0) return;

  if (identity === undefined || identity.config === null) {
    result.identitySkipped = true;
    console.log(
      JSON.stringify({
        level: "warn",
        message: "identity release skipped: no Firebase config",
        due: rows.length,
      })
    );
    return;
  }

  if (email === null) result.emailSkipped = true;
  const deleteUser = identity.deleteUser ?? deleteFirebaseUser;

  for (const user of rows) {
    if (dryRun) {
      result.identitiesReleased += 1;
      continue;
    }

    // The notice first, and a failed notice holds this account's release -
    // unless it has been failing for two days past due, in which case the
    // address is not going to accept it and the person's identity must not
    // wait on it any longer. See ERASURE_NOTICE_GRACE_MS.
    if (email !== null && user.erasure_notified_at === null) {
      const sent = await sendFinalNotice(db, email, user, now);
      if (sent) {
        result.erasureEmailsSent += 1;
      } else {
        result.erasureEmailsFailed += 1;
        if (now < user.purge_after + ERASURE_NOTICE_GRACE_MS) continue;
      }
    }

    try {
      await deleteUser(identity.config, identity.kv, user.firebase_uid, now);
      await releaseAddress(db, user.id, now);
      result.identitiesReleased += 1;
    } catch (err) {
      result.failed += 1;
      console.log(
        JSON.stringify({
          level: "warn",
          message: "identity release failed",
          userId: user.id,
          reason: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }
}

/**
 * Stamp the run as over.
 *
 * `finished_at` staying NULL is how a run that died mid-flight is told from one
 * that completed, and the console renders that as "interrupted" rather than
 * hiding it - a job that stopped reporting is the thing you most want to see.
 */
async function finish(
  db: D1Database,
  runId: string,
  now: number,
  result: SweepResult,
  error: string | null
): Promise<void> {
  await db
    .prepare(
      `UPDATE job_runs
          SET finished_at = ?, examined = ?, objects_deleted = ?, rows_deleted = ?,
              bytes_freed = ?, failed = ?, error = ?
        WHERE id = ?`
    )
    .bind(
      now,
      result.examined,
      result.objectsDeleted,
      result.rowsDeleted,
      result.bytesFreed,
      result.failed,
      error,
      runId
    )
    .run();
}
