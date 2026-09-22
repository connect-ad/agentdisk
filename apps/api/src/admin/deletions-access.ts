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
import { UNCLAIMED_TTL_MS } from "../lib/claim";

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

export type ClaimLinkState = "all" | "unclaimed" | "claimed" | "due";

export interface ClaimLinkRow {
  workspaceId: string;
  name: string;
  createdAt: number;
  claimedAt: number | null;
  tokenHash: string;
  expiresAt: number | null;
  storageBytes: number;
  fileCount: number;
  claimedByEmail: string | null;
  attempts: number;
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
   * Every claim link, and where it stands.
   *
   * Queried over `workspaces` rather than over `claim_attempts`, deliberately:
   * a link exists whether or not anybody has ever touched it, and the ones
   * nobody has touched are exactly what somebody looks for when asked why a
   * person never received theirs. Attempts are counted alongside rather than
   * being the subject.
   *
   * `due` is the set the next sweep will destroy - unclaimed and past its TTL.
   * It is what you check before pressing run-now, and the only one of the four
   * filters that answers a question with a deadline attached.
   *
   * The token hash is returned, never a token. There is no token to return;
   * only the hash was ever stored.
   */
  async claimLinks(state: ClaimLinkState, q: string | null, limit = 50): Promise<ClaimLinkRow[]> {
    const clauses = ["w.claim_token_hash IS NOT NULL"];
    const binds: (string | number)[] = [];

    if (state === "unclaimed") clauses.push("w.claimed_at IS NULL");
    if (state === "claimed") clauses.push("w.claimed_at IS NOT NULL");
    if (state === "due") {
      clauses.push("w.claimed_at IS NULL AND w.created_at <= ?");
      binds.push(this.now - UNCLAIMED_TTL_MS);
    }
    if (q !== null && q !== "") {
      // One box, two kinds of identifier: a workspace id from a support
      // thread, or a token hash copied out of the attempt log.
      clauses.push("(w.id = ? OR w.claim_token_hash = ?)");
      binds.push(q, q);
    }
    binds.push(limit);

    const rows = await this.db
      .prepare(
        `SELECT w.id AS workspaceId, w.name, w.created_at AS createdAt,
                w.claimed_at AS claimedAt, w.claim_token_hash AS tokenHash,
                w.claim_token_expires_at AS expiresAt,
                w.storage_bytes_used AS storageBytes, w.file_count AS fileCount,
                u.email AS claimedByEmail,
                (SELECT COUNT(*) FROM claim_attempts a WHERE a.workspace_id = w.id) AS attempts
           FROM workspaces w
           LEFT JOIN memberships m ON m.workspace_id = w.id AND m.role = 'owner'
           LEFT JOIN users u ON u.id = m.user_id
          WHERE ${clauses.join(" AND ")}
          ORDER BY w.created_at DESC
          LIMIT ?`
      )
      .bind(...binds)
      .all<ClaimLinkRow>();
    return rows.results ?? [];
  }

  /** One link's history, newest first. */
  async claimAttempts(tokenHash: string, limit = 50) {
    const rows = await this.db
      .prepare(
        `SELECT id, outcome, user_id AS userId, ip, user_agent AS userAgent,
                created_at AS createdAt
           FROM claim_attempts
          WHERE token_hash = ?
          ORDER BY created_at DESC
          LIMIT ?`
      )
      .bind(tokenHash, limit)
      .all();
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
