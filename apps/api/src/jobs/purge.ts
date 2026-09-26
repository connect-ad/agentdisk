/**
 * Reaping stranded file rows, and keeping the counters honest — 05 PART 12.5,
 * 10.8.
 *
 * Deleting is permanent and happens in the request: mark the row, delete the
 * R2 object, delete the row. This job exists because those are three steps
 * across two systems with no transaction between them, so a request can die
 * after the first and leave a row marked `deleted` whose bytes are still there
 * — invisible to every read, billed by Cloudflare, charged to nobody.
 *
 * It used to be the 24-hour grace period itself, back when a delete was soft
 * and `POST /v1/files/:id/restore` could undo one. Both are gone; what survives
 * is the half that cleans up, because the failure it cleans up after did not go
 * anywhere.
 *
 * Two jobs, deliberately in one file because they exist for the same reason:
 * D1 and R2 are separate systems with no transaction between them, so they can
 * disagree, and both of these are about making them agree again.
 *
 * **The reaper is idempotent and forgiving.** It deletes the object, then the
 * row. If the object is already gone — a retry, a request that got further than
 * it looked — that is a success, not an error: the desired state is "no
 * object", and it holds.
 *
 * **Reconciliation never trusts the counters it is checking.** It recomputes
 * from the rows themselves. A counter that drifted is exactly the value you
 * cannot use to detect that it drifted.
 */

/**
 * How long a marked row is left alone before the reaper takes it.
 *
 * Not a grace period — nothing is recoverable in this window and no API can
 * bring a file back. It is a margin against reaping a row whose own request is
 * still running: `deleteFile` marks, then awaits R2, and a reaper that deleted
 * the row underneath it would race for no reason. A minute is far longer than
 * that gap and far shorter than anything a customer could notice.
 */
export const REAP_AFTER_MS = 60 * 1000;

/** Bounded so one run cannot exceed a Worker's CPU or wall-clock budget. */
const REAP_BATCH = 100;

export interface ReapResult {
  examined: number;
  objectsDeleted: number;
  rowsDeleted: number;
  failed: number;
}

interface ReapCandidate {
  id: string;
  workspace_id: string;
  r2_object_key: string | null;
}

/**
 * Finish off rows whose delete did not complete.
 *
 * Ordered oldest-first so a backlog drains in the order it accumulated rather
 * than starving the earliest deletions forever.
 */
export async function reapStrandedFiles(
  db: D1Database,
  files: R2Bucket,
  now: number,
  limit = REAP_BATCH
): Promise<ReapResult> {
  const cutoff = now - REAP_AFTER_MS;

  const candidates = await db
    .prepare(
      `SELECT id, workspace_id, r2_object_key
         FROM files
        WHERE status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at <= ?
        ORDER BY deleted_at ASC
        LIMIT ?`
    )
    .bind(cutoff, limit)
    .all<ReapCandidate>();

  const rows = candidates.results ?? [];
  const result: ReapResult = { examined: rows.length, objectsDeleted: 0, rowsDeleted: 0, failed: 0 };

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
      // One bad row must not stop the batch. It stays marked and is picked up
      // next run, which is the correct behaviour for a transient R2 or D1
      // failure.
      result.failed += 1;
      console.log(
        JSON.stringify({
          level: "warn",
          message: "reap failed for one file",
          fileId: row.id,
          workspaceId: row.workspace_id,
          reason: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }

  return result;
}

/**
 * Housekeeping, not enforcement. An expired row already serves nothing —
 * `findShareByToken` has the expiry in its WHERE clause, and the plan limit
 * counts unexpired rows — so this only keeps the table from growing.
 */
export async function purgeExpiredShares(db: D1Database, now: number): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM share_links WHERE expires_at <= ?`)
    .bind(now)
    .run();
  return result.meta.changes ?? 0;
}

export interface ReconcileResult {
  workspacesChecked: number;
  workspacesCorrected: number;
  organizationsChecked: number;
  organizationsCorrected: number;
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
 * Only `active` files count. A row still marked `deleted` released its quota
 * when the delete was accepted (12.5) and is waiting on the reaper, so counting
 * it would re-bill storage the customer has already destroyed.
 *
 * **Two levels since migration 0017**, because the quota is decided from the
 * organization's totals and the workspace's are what a person sees. The
 * account pass recomputes from `files` directly rather than by summing the
 * workspace counters it has just fixed: the workspace pass is paginated, so
 * summing them would fold this run's unvisited workspaces - and any drift left
 * in them - into the number the enforcement path reads. Deriving both levels
 * from the same source means they cannot disagree about anything except drift,
 * and drift at one level cannot propagate to the other.
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

  const organizations = await db
    .prepare(`SELECT id, storage_bytes_used, file_count FROM organizations ORDER BY id LIMIT ?`)
    .bind(limit)
    .all<{ id: string; storage_bytes_used: number; file_count: number }>();

  const orgRows = organizations.results ?? [];
  let orgsCorrected = 0;

  for (const org of orgRows) {
    const truth = await db
      .prepare(
        `SELECT COALESCE(SUM(f.size_bytes), 0) AS bytes, COUNT(*) AS files
           FROM files f
           JOIN workspaces w ON w.id = f.workspace_id
          WHERE w.org_id = ? AND f.status = 'active'`
      )
      .bind(org.id)
      .first<{ bytes: number; files: number }>();

    if (truth === null) continue;
    if (truth.bytes === org.storage_bytes_used && truth.files === org.file_count) {
      continue;
    }

    await db
      .prepare(
        `UPDATE organizations SET storage_bytes_used = ?, file_count = ?, updated_at = ? WHERE id = ?`
      )
      .bind(truth.bytes, truth.files, now, org.id)
      .run();
    orgsCorrected += 1;

    // Louder than the workspace case, in the sense that it matters more: this
    // is the number every write in the account is refused or allowed on.
    console.log(
      JSON.stringify({
        level: "warn",
        message: "account counter drift corrected",
        orgId: org.id,
        was: { bytes: org.storage_bytes_used, files: org.file_count },
        now: { bytes: truth.bytes, files: truth.files },
      })
    );
  }

  return {
    workspacesChecked: rows.length,
    workspacesCorrected: corrected,
    organizationsChecked: orgRows.length,
    organizationsCorrected: orgsCorrected,
  };
}
