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

/** R2 accepts up to 1000 keys in one delete. */
const R2_DELETE_CHUNK = 1000;

/** Bounded so one run cannot exceed a Worker's CPU or wall-clock budget. */
const DEFAULT_LIMIT = 500;

export interface SweepResult {
  examined: number;
  objectsDeleted: number;
  rowsDeleted: number;
  bytesFreed: number;
  failed: number;
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
  trigger?: "cron" | "staff";
  actorId?: string | null;
  actorEmail?: string | null;
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
 * as SANDBOX_EXPIRY_ENABLED and STAFF_PURGE_ENABLED before it.
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

    await finish(db, runId, now, result, null);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finish(db, runId, now, result, message.slice(0, 500));
    throw err;
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
