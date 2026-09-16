/**
 * Purging soft-deleted files, and keeping the counters honest — 05 PART 12.5,
 * 10.8.
 *
 * A delete marks the row and releases the quota immediately; the R2 object
 * survives so a restore is possible for 24 hours. Nothing removed those objects
 * afterwards, so every deleted file was still occupying real storage this
 * product was paying Cloudflare for and no longer charging anybody for. This is
 * the other half.
 *
 * Two jobs, deliberately in one file because they exist for the same reason:
 * D1 and R2 are separate systems with no transaction between them, so they can
 * disagree, and both of these are about making them agree again.
 *
 * **Purge is idempotent and forgiving.** It deletes the object, then the row.
 * If the object is already gone — a retry, a manual cleanup — that is a
 * success, not an error: the desired state is "no object", and it holds.
 *
 * **Reconciliation never trusts the counters it is checking.** It recomputes
 * from the rows themselves. A counter that drifted is exactly the value you
 * cannot use to detect that it drifted.
 */

/** 12.5's grace period. A file deleted inside this window can still be restored. */
export const PURGE_GRACE_MS = 24 * 60 * 60 * 1000;

/** Bounded so one run cannot exceed a Worker's CPU or wall-clock budget. */
const PURGE_BATCH = 100;

export interface PurgeResult {
  examined: number;
  objectsDeleted: number;
  rowsDeleted: number;
  failed: number;
}

interface PurgeCandidate {
  id: string;
  workspace_id: string;
  r2_object_key: string | null;
}

/**
 * Remove files whose grace period has passed.
 *
 * Ordered oldest-first so a backlog drains in the order it accumulated rather
 * than starving the earliest deletions forever.
 */
export async function purgeExpiredFiles(
  db: D1Database,
  files: R2Bucket,
  now: number,
  limit = PURGE_BATCH
): Promise<PurgeResult> {
  const cutoff = now - PURGE_GRACE_MS;

  const candidates = await db
    .prepare(
      `SELECT id, workspace_id, r2_object_key
         FROM files
        WHERE status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at <= ?
        ORDER BY deleted_at ASC
        LIMIT ?`
    )
    .bind(cutoff, limit)
    .all<PurgeCandidate>();

  const rows = candidates.results ?? [];
  const result: PurgeResult = { examined: rows.length, objectsDeleted: 0, rowsDeleted: 0, failed: 0 };

  for (const row of rows) {
    try {
      if (row.r2_object_key !== null) {
        // R2's delete is idempotent - removing an absent key succeeds - which
        // is exactly what a retry needs.
        await files.delete(row.r2_object_key);
        result.objectsDeleted += 1;
      }

      // The row goes only after the object. The other order can strand bytes
      // nothing points at, which is the one failure this job cannot later
      // detect, because the record of what to delete is gone.
      await db
        .prepare(`DELETE FROM file_tags WHERE file_id = ?`)
        .bind(row.id)
        .run();
      await db.prepare(`DELETE FROM files WHERE id = ?`).bind(row.id).run();
      result.rowsDeleted += 1;
    } catch (err) {
      // One bad row must not stop the batch. It stays deleted-but-unpurged and
      // is picked up next run, which is the correct behaviour for a transient
      // R2 or D1 failure.
      result.failed += 1;
      console.log(
        JSON.stringify({
          level: "warn",
          message: "purge failed for one file",
          fileId: row.id,
          workspaceId: row.workspace_id,
          reason: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }

  return result;
}

export interface ReconcileResult {
  workspacesChecked: number;
  workspacesCorrected: number;
}

/**
 * Recompute `storage_bytes_used` and `file_count` from the rows.
 *
 * These counters are maintained incrementally on every upload and delete
 * because summing the table on each request would be absurd — but incremental
 * counters drift, and a customer billed against a drifted counter is either
 * overcharged or getting free storage. This is what makes that self-correcting
 * rather than permanent.
 *
 * Only `active` files count. A soft-deleted file already released its quota at
 * delete time (12.5), which is the customer-friendly choice: they stop paying
 * the moment they delete, not 24 hours later.
 */
export async function reconcileCounters(
  db: D1Database,
  now: number,
  limit = 200
): Promise<ReconcileResult> {
  const workspaces = await db
    .prepare(`SELECT id, storage_bytes_used, file_count FROM workspaces ORDER BY id LIMIT ?`)
    .bind(limit)
    .all<{ id: string; storage_bytes_used: number; file_count: number }>();

  const rows = workspaces.results ?? [];
  let corrected = 0;

  for (const workspace of rows) {
    const truth = await db
      .prepare(
        `SELECT COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS files
           FROM files WHERE workspace_id = ? AND status = 'active'`
      )
      .bind(workspace.id)
      .first<{ bytes: number; files: number }>();

    if (truth === null) continue;
    if (truth.bytes === workspace.storage_bytes_used && truth.files === workspace.file_count) {
      continue;
    }

    await db
      .prepare(
        `UPDATE workspaces SET storage_bytes_used = ?, file_count = ?, updated_at = ? WHERE id = ?`
      )
      .bind(truth.bytes, truth.files, now, workspace.id)
      .run();
    corrected += 1;

    // Logged rather than silent. Drift is a symptom, and a job that quietly
    // fixes symptoms every hour hides whatever is causing them.
    console.log(
      JSON.stringify({
        level: "warn",
        message: "counter drift corrected",
        workspaceId: workspace.id,
        was: { bytes: workspace.storage_bytes_used, files: workspace.file_count },
        now: { bytes: truth.bytes, files: truth.files },
      })
    );
  }

  return { workspacesChecked: rows.length, workspacesCorrected: corrected };
}
