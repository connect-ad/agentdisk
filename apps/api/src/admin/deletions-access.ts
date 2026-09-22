/**
 * The deletion queue, its history, and a control to run it now.
 *
 * `job_runs` has been written by the sweep since the deferred-deletion work
 * landed and read by nothing, so nobody could see what was queued, what the
 * last run did, or whether the job was running at all. That is the gap this
 * closes.
 *
 * Extends `AuditedAdminAccess` like every other area, which matters more here
 * than elsewhere: the run-now control erases bytes on demand, ahead of the
 * window a customer was promised, so it must not be possible to perform without
 * the machinery that writes down who asked.
 */

import { AuditedAdminAccess } from "./audited";
import {
  sweepPendingDeletions,
  pendingDeletionEnabled,
  type SweepResult,
} from "../jobs/pending-deletions";
import { readFirebaseAdminConfig } from "../auth/firebase-admin";

export interface DeletionQueue {
  /** File rows waiting for their bytes to be erased. */
  files: number;
  /** What those rows will free. */
  bytes: number;
  /** Already past their due date — what the next run will take. */
  overdue: number;
  /** The oldest entry, so a stalled queue is visible as age rather than count. */
  oldestMarkedAt: number | null;
  /** Accounts whose identity and address are queued for release. */
  accounts: number;
  /** Of those, how many are already due. */
  accountsOverdue: number;
}

export interface JobRunRow {
  id: string;
  trigger: string;
  actorEmail: string | null;
  dryRun: number;
  startedAt: number;
  finishedAt: number | null;
  examined: number;
  objectsDeleted: number;
  rowsDeleted: number;
  bytesFreed: number;
  failed: number;
  error: string | null;
}

/** What the sweep needs that `AdminDeps` does not already carry. */
export interface SweepBindings {
  files: R2Bucket;
  env: {
    PENDING_DELETION_ENABLED?: string;
    FIREBASE_SERVICE_ACCOUNT_JSON?: string;
    FIREBASE_PROJECT_ID?: string;
  };
  kv: KVNamespace;
}

export class AdminDeletionsAccess extends AuditedAdminAccess {
  /**
   * What is waiting, in both halves.
   *
   * Bytes and accounts are counted separately rather than summed into one
   * "pending" number, because they answer different questions: one is storage
   * still being paid for, the other is people who cannot yet sign up again
   * with their own address.
   */
  async queue(): Promise<DeletionQueue> {
    const files = await this.db
      .prepare(
        `SELECT COUNT(*) AS files,
                COALESCE(SUM(size_bytes), 0) AS bytes,
                COALESCE(SUM(CASE WHEN due_at <= ? THEN 1 ELSE 0 END), 0) AS overdue,
                MIN(marked_at) AS oldestMarkedAt
           FROM pending_deletions`
      )
      .bind(this.now)
      .first<{ files: number; bytes: number; overdue: number; oldestMarkedAt: number | null }>();

    const accounts = await this.db
      .prepare(
        `SELECT COUNT(*) AS accounts,
                COALESCE(SUM(CASE WHEN purge_after <= ? THEN 1 ELSE 0 END), 0) AS accountsOverdue
           FROM users
          WHERE purge_after IS NOT NULL AND deleted_at IS NOT NULL`
      )
      .bind(this.now)
      .first<{ accounts: number; accountsOverdue: number }>();

    return {
      files: files?.files ?? 0,
      bytes: files?.bytes ?? 0,
      overdue: files?.overdue ?? 0,
      oldestMarkedAt: files?.oldestMarkedAt ?? null,
      accounts: accounts?.accounts ?? 0,
      accountsOverdue: accounts?.accountsOverdue ?? 0,
    };
  }

  /**
   * Recent runs, newest first.
   *
   * `finishedAt` staying null is how a run that died mid-flight is told from
   * one that completed, and the screen shows it as "interrupted" rather than
   * hiding it — a job that stopped reporting is the thing you most want to see.
   */
  async runs(limit = 20): Promise<JobRunRow[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, trigger, actor_email AS actorEmail, dry_run AS dryRun,
                started_at AS startedAt, finished_at AS finishedAt,
                examined, objects_deleted AS objectsDeleted, rows_deleted AS rowsDeleted,
                bytes_freed AS bytesFreed, failed, error
           FROM job_runs
          WHERE job = 'pending_deletions'
          ORDER BY started_at DESC
          LIMIT ?`
      )
      .bind(limit)
      .all<JobRunRow>();
    return rows.results ?? [];
  }

  /**
   * Run the sweep now.
   *
   * Honours `PENDING_DELETION_ENABLED` rather than overriding it. A button that
   * could delete while the environment says not to would make the flag a
   * suggestion, and the flag is the thing standing between a misconfigured
   * deployment and somebody's files.
   *
   * `force` is separate and deliberately not exposed here: taking rows before
   * their due date breaks the seven-day promise, and doing that needs a
   * conversation rather than a button.
   */
  async runNow(bindings: SweepBindings, reason: string): Promise<SweepResult> {
    await this.requireRole("admin", "run the deletion sweep");

    const result = await sweepPendingDeletions(this.db, bindings.files, this.now, {
      dryRun: !pendingDeletionEnabled(bindings.env),
      trigger: "admin",
      actorId: this.admin.id,
      actorEmail: this.admin.email,
      identity: { config: readFirebaseAdminConfig(bindings.env), kv: bindings.kv },
    });

    await this.recordFleet({
      action: "deletions.run",
      targetType: "job_run",
      targetId: result.runId,
      reason,
      metadata: {
        dryRun: result.dryRun,
        objectsDeleted: result.objectsDeleted,
        bytesFreed: result.bytesFreed,
        identitiesReleased: result.identitiesReleased,
        failed: result.failed,
      },
    });

    return result;
  }
}
