/**
 * Reclaiming sandbox workspaces nobody ever claimed.
 *
 * Before this existed, `POST /v1/workspaces` was a way for an anonymous caller
 * to create a workspace that lived forever. Nothing set `claimed_at`, nothing
 * read it, and nothing ever removed a workspace that was never claimed - so the
 * only bound on how much storage a stranger could permanently occupy was the
 * rate limit of ten new workspaces per hour per IP, each able to hold the full
 * free plan's 2 GB. This is the other half of that endpoint.
 *
 * ---
 *
 * **This job runs in log-only mode unless it is explicitly switched on, and the
 * default is deliberate rather than cautious boilerplate.**
 *
 * The dev environment already holds weeks of unclaimed sandboxes from earlier
 * testing. Every one of them is, by this job's definition, expired - so the
 * first cron tick after deploying a delete-enabled version would destroy all of
 * them, immediately, with no review and no undo. A workspace delete here is not
 * soft: `deleteWorkspaceCascade` removes the R2 objects and then the rows, and
 * the rows are the only record that the objects existed.
 *
 * So the switch defaults to off. `dryRun` is true unless a caller passes false,
 * and the only caller in production (`scheduled()` in index.ts) passes false
 * only when `SANDBOX_EXPIRY_ENABLED` is exactly "true". Ship it, read one full
 * TTL window of `sandbox expiry candidates` log lines, confirm the list is what
 * you expect, and only then set the variable.
 *
 * A dry run does real work: it runs the same query, resolves the same
 * candidates, and reports their IDs, ages and sizes. What it does not do is
 * call the cascade.
 */

import { UNCLAIMED_TTL_MS } from "../lib/claim";
import { deleteProvisionalOwner, deleteWorkspaceCascade } from "../db/workspace-cascade";

export { UNCLAIMED_TTL_MS };

/**
 * Bounded so one run cannot exceed a Worker's CPU or wall-clock budget, and so
 * a backlog drains over several ticks rather than one enormous one. The cron
 * runs hourly; at 50 per tick a thousand abandoned sandboxes clear in a day.
 */
const EXPIRY_BATCH = 50;

export interface ExpiryCandidate {
  workspaceId: string;
  orgId: string;
  name: string;
  ageDays: number;
  fileCount: number;
  storageBytes: number;
}

export interface ExpireResult {
  /** True when nothing was deleted and this was a report only. */
  dryRun: boolean;
  examined: number;
  workspacesDeleted: number;
  objectsDeleted: number;
  failed: number;
  /** What was (or would have been) removed. Always populated, both modes. */
  candidates: ExpiryCandidate[];
}

interface CandidateRow {
  id: string;
  org_id: string;
  name: string;
  created_at: number;
  file_count: number;
  storage_bytes_used: number;
}

/**
 * Delete unclaimed workspaces older than `ttlMs`, or report what would be.
 *
 * Ordered oldest-first so a backlog drains in the order it accumulated, rather
 * than starving the earliest abandoned workspaces forever - the same reasoning
 * `reapStrandedFiles` gives for its own ordering.
 *
 * There is no grace period and nothing to undo, which is now what a file delete
 * does too - this used to be the exception and is no longer. A workspace nobody
 * claimed in a week has no owner to restore it for anyway; the claim link is
 * the grace period.
 */
export async function expireUnclaimedWorkspaces(
  db: D1Database,
  files: R2Bucket,
  now: number,
  ttlMs: number = UNCLAIMED_TTL_MS,
  limit: number = EXPIRY_BATCH,
  dryRun = true
): Promise<ExpireResult> {
  const cutoff = now - ttlMs;

  const found = await db
    .prepare(
      `SELECT id, org_id, name, created_at, file_count, storage_bytes_used
         FROM workspaces
        WHERE claimed_at IS NULL
          AND created_at <= ?
        ORDER BY created_at ASC
        LIMIT ?`
    )
    .bind(cutoff, limit)
    .all<CandidateRow>();

  const rows = found.results ?? [];
  const candidates: ExpiryCandidate[] = rows.map(row => ({
    workspaceId: row.id,
    orgId: row.org_id,
    name: row.name,
    ageDays: Math.floor((now - row.created_at) / (24 * 60 * 60 * 1000)),
    fileCount: row.file_count,
    storageBytes: row.storage_bytes_used,
  }));

  const result: ExpireResult = {
    dryRun,
    examined: rows.length,
    workspacesDeleted: 0,
    objectsDeleted: 0,
    failed: 0,
    candidates,
  };

  if (dryRun) {
    // One line, at warn, carrying every ID. This is the artifact somebody reads
    // before turning the job on, so it has to be complete rather than a count.
    if (candidates.length > 0) {
      console.log(
        JSON.stringify({
          level: "warn",
          message: "sandbox expiry candidates (dry run - nothing deleted)",
          ttlDays: Math.round(ttlMs / (24 * 60 * 60 * 1000)),
          count: candidates.length,
          candidates,
        })
      );
    }
    return result;
  }

  for (const candidate of candidates) {
    try {
      // Re-assert the condition inside the loop. The rows were read at the top
      // of a job that may have been running for a while, and a claim that
      // landed in between must win - deleting a workspace somebody claimed
      // thirty seconds ago is the one unrecoverable mistake this job can make.
      const stillUnclaimed = await db
        .prepare(`SELECT 1 AS ok FROM workspaces WHERE id = ? AND claimed_at IS NULL`)
        .bind(candidate.workspaceId)
        .first<{ ok: number }>();
      if (stillUnclaimed === null) continue;

      const owner = await db
        .prepare(`SELECT owner_user_id FROM organizations WHERE id = ?`)
        .bind(candidate.orgId)
        .first<{ owner_user_id: string }>();

      const { objectsDeleted } = await deleteWorkspaceCascade(db, files, candidate.workspaceId);
      await deleteProvisionalOwner(db, candidate.orgId, owner?.owner_user_id ?? "");

      result.objectsDeleted += objectsDeleted;
      result.workspacesDeleted += 1;

      // Logged rather than audited, and forced rather than chosen:
      // `audit_events` is workspace-scoped by foreign key, so the one row
      // describing a workspace's destruction is the one row it cannot hold.
      // The same constraint `deleteWorkspaceForUser` documents.
      console.log(
        JSON.stringify({
          level: "warn",
          message: "unclaimed workspace expired",
          workspaceId: candidate.workspaceId,
          ageDays: candidate.ageDays,
          files: candidate.fileCount,
          bytes: candidate.storageBytes,
          at: new Date(now).toISOString(),
        })
      );
    } catch (err) {
      // One bad workspace must not stop the batch. It stays expired-but-present
      // and is picked up next run, which is correct for a transient R2 or D1
      // failure - the same forgiveness `reapStrandedFiles` extends per file.
      result.failed += 1;
      console.log(
        JSON.stringify({
          level: "error",
          message: "sandbox expiry failed for one workspace",
          workspaceId: candidate.workspaceId,
          reason: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }

  return result;
}
