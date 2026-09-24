/**
 * The renewal ladder — owner's decision, 23 September 2026.
 *
 * AgentDisk does not auto-renew. A purchase buys one month; nothing charges the
 * customer again. This job is what makes that humane rather than merely
 * hands-off: it warns before the period ends, locks writes when it does, and
 * schedules the data for deletion a week later if nobody comes back.
 *
 * ```
 * day -7        day 0          day +7            day +14
 *   |             |              |                  |
 *   o------------>o=============>o=================>X
 *   |   live      |   grace      |   notice         |
 * reminder    write lock    deletion            DATA GONE
 * email       + email       scheduled + email
 * ```
 *
 * Four passes, not three. `purge_after` was written by the scheduling pass and
 * read by nothing that acted on it, so the third email promised a deletion this
 * product could not perform — every consumer of that column name in the codebase
 * reads `users.purge_after`, not the organization's. The fourth pass is the
 * ending, and it lives here so that one file owns one lifecycle: the clock that
 * schedules the deletion is the clock that performs it.
 *
 * ── State changes and emails are separate passes, deliberately ──────────────
 * The obvious shape is "find the due accounts, change them, email them." It has
 * a failure that only appears in production: if the email throws, the state has
 * already changed, so the row no longer matches the query and **the message is
 * never sent again**. The customer is locked out with no explanation.
 *
 * Inverting it is worse. If the email must succeed before the state changes,
 * then an email outage stops accounts expiring at all — a billing
 * failure that quietly grants free service, which is the direction never to
 * fail in.
 *
 * So the two are independent. A state pass selects on state and always
 * succeeds. A notification pass selects on state AND the absence of a
 * `notifications_sent` row, so it retries every hour until the message actually
 * goes out, and stops the moment it has. Neither can block the other.
 *
 * ── The guard is the unique index, not this code ────────────────────────────
 * `idx_notifications_once` over (org_id, kind, period_end) is what makes each
 * message once-per-period. The cron runs hourly; a guard implemented as an
 * `if` here would be one refactor away from sending 168 copies of "your data is
 * scheduled for deletion". The row is claimed AFTER a successful send, so a
 * failed send leaves nothing behind and simply retries.
 *
 * ── It reports before it acts ───────────────────────────────────────────────
 * `dryRun` defaults to true and only `BILLING_EXPIRY_ENABLED = "true"` turns on
 * real work, the same shape as the sandbox sweep and the admin purge, for the
 * same reason: the moment this ships, dev fills with accounts that are expired
 * by definition, and the first tick of a delete-enabled version would stamp all
 * of them at once. A dry run does every query and reports every candidate; what
 * it does not do is write or send.
 */

import { newId } from "../lib/ids";
import { deleteWorkspaceCascade } from "../db/workspace-cascade";
import { defaultPlanId, loadCatalogue } from "../billing/catalogue";
import {
  RENEWAL_GRACE_MS,
  RENEWAL_NOTICE_MS,
  RENEWAL_REMINDER_MS,
  deletionScheduledAt,
  formatPeriodDate,
} from "../lib/renewal";
import {
  sendDeletionScheduledEmail,
  sendPlanExpiredEmail,
  sendRenewalReminderEmail,
  type EmailConfig,
} from "../lib/email";

/**
 * Bounded so one run cannot exceed a Worker's CPU or wall-clock budget, and so
 * a backlog drains over several hourly ticks rather than one enormous one.
 */
const BATCH = 100;

/**
 * The three messages. Kept here rather than as a CHECK constraint on the table,
 * so adding a fourth is a template and a line, not a migration SQLite cannot
 * perform in place.
 */
export type NotificationKind = "renewal_reminder" | "expired" | "deletion_scheduled";

/** One account the ladder touched, as the logs and the tests read it. */
export interface RenewalCandidate {
  orgId: string;
  plan: string;
  planName: string;
  ownerEmail: string | null;
  periodEnd: number;
  /** The workspace a renew link points at, or null when the org has none live. */
  workspaceSlug: string | null;
}

export interface RenewalResult {
  /** True when nothing was written and no message was sent. */
  dryRun: boolean;
  /** Reminded that a period is about to end. */
  reminded: number;
  /** Moved from active to expired. */
  expired: number;
  /** Stamped with `purge_after`. */
  deletionsScheduled: number;
  /** Accounts whose data was actually removed — the end of the lifecycle. */
  purged: number;
  /** R2 objects destroyed by those purges. */
  objectsDeleted: number;
  /** Due accounts that renewed between selection and the delete. */
  purgeSkipped: number;
  /** Purges that failed and keep their stamp for the next tick. */
  purgeFailed: number;
  /** Messages actually accepted by the provider. */
  emailsSent: number;
  /** Messages that could not be sent, and will be retried next tick. */
  emailsFailed: number;
  /** Accounts with no reachable owner address. State still changed for these. */
  unreachable: number;
  /** True when this deployment has no email configuration at all. */
  emailSkipped: boolean;
  candidates: {
    reminder: RenewalCandidate[];
    expiry: RenewalCandidate[];
    deletion: RenewalCandidate[];
    purge: RenewalCandidate[];
  };
}

export interface RenewalDeps {
  db: D1Database;
  /**
   * The files bucket, for the purge pass.
   *
   * Optional, and its absence is a real state rather than a misconfiguration to
   * throw on: a caller that only wants the reminder and expiry passes should get
   * them. Without it the purge reports its candidates and deletes nothing, which
   * is the safe half of the trade — the alternative is deleting D1 rows while
   * the objects they name survive, orphaned beyond recovery.
   */
  files?: R2Bucket;
  /** Null when this deployment cannot send. State changes still happen. */
  email: EmailConfig | null;
  /** Root of the dashboard, for building the renew link. */
  dashboardUrl: string;
  now: number;
  dryRun?: boolean;
  limit?: number;
}

interface CandidateRow {
  orgId: string;
  plan: string;
  planName: string | null;
  ownerEmail: string | null;
  periodEnd: number;
  workspaceSlug: string | null;
}

/**
 * Everything the ladder needs about an organization, in one shape.
 *
 * `users` and `plans` are both LEFT joined. An inner join on `users` would mean
 * an organization whose owner row is missing never expires and never gets
 * swept — service granted forever by an absence, which is the same fail-wide
 * `findOrgForWorkspace` was caught in. The address being unavailable must cost
 * the customer a message, never cost us the state change.
 *
 * The workspace slug is a correlated subquery rather than a join so that an
 * organization with several workspaces produces exactly one row. Oldest first,
 * because that is the one a person thinks of as theirs.
 */
const SELECT_CANDIDATE = `
  SELECT o.id AS orgId,
         o.plan AS plan,
         p.name AS planName,
         u.email AS ownerEmail,
         o.current_period_end AS periodEnd,
         (SELECT w.slug FROM workspaces w
           WHERE w.org_id = o.id AND w.status != 'deleted'
           ORDER BY w.created_at ASC LIMIT 1) AS workspaceSlug
    FROM organizations o
    LEFT JOIN users u ON u.id = o.owner_user_id
    LEFT JOIN plans p ON p.id = o.plan
`;

function asCandidate(row: CandidateRow): RenewalCandidate {
  return {
    orgId: row.orgId,
    plan: row.plan,
    // The catalogue's display name when there is one, else the id. A plan
    // retired since purchase still has to be nameable in a message.
    planName: row.planName ?? row.plan,
    ownerEmail: row.ownerEmail,
    periodEnd: row.periodEnd,
    workspaceSlug: row.workspaceSlug,
  };
}

/** Where "Renew" sends somebody. The workspace's own billing page when we know one. */
function renewUrl(dashboardUrl: string, candidate: RenewalCandidate): string {
  return candidate.workspaceSlug === null
    ? `${dashboardUrl}/app`
    : `${dashboardUrl}/w/${candidate.workspaceSlug}/billing`;
}

/**
 * Run the whole ladder.
 *
 * The order matters: expire before scheduling deletions, so an account that
 * crosses both boundaries in one tick — possible after an outage, or on the
 * first run after this ships — still passes through the expired state and its
 * message rather than jumping straight to deletion with no warning.
 */
export async function runRenewalLadder(deps: RenewalDeps): Promise<RenewalResult> {
  const { db, now } = deps;
  const dryRun = deps.dryRun ?? true;
  const limit = deps.limit ?? BATCH;

  const result: RenewalResult = {
    dryRun,
    reminded: 0,
    expired: 0,
    deletionsScheduled: 0,
    purged: 0,
    objectsDeleted: 0,
    purgeSkipped: 0,
    purgeFailed: 0,
    emailsSent: 0,
    emailsFailed: 0,
    unreachable: 0,
    emailSkipped: deps.email === null,
    candidates: { reminder: [], expiry: [], deletion: [], purge: [] },
  };

  /* ---------------------------- state passes ---------------------------- */

  // Expiry. Selects on `active` alone, so it is idempotent: a row it has
  // already moved cannot match again.
  const expiring = await db
    .prepare(
      `${SELECT_CANDIDATE}
        WHERE o.billing_status = 'active'
          AND o.current_period_end IS NOT NULL
          AND o.current_period_end <= ?
        ORDER BY o.current_period_end ASC
        LIMIT ?`
    )
    .bind(now, limit)
    .all<CandidateRow>();

  result.candidates.expiry = (expiring.results ?? []).map(asCandidate);

  if (!dryRun) {
    for (const candidate of result.candidates.expiry) {
      // The plan is deliberately NOT dropped to the default here. An account
      // holding 40 GB on Pro, moved to Free's 1 GB, is instantly over quota
      // through no act of its own, and every usage screen would report a breach
      // the customer cannot fix except by deleting files during the exact
      // window we are asking them to renew in. The write lock already stops new
      // data; the plan is only what the existing data is measured against.
      await db
        .prepare(
          `UPDATE organizations SET billing_status = 'expired', updated_at = ?
            WHERE id = ? AND billing_status = 'active'`
        )
        .bind(now, candidate.orgId)
        .run();
      result.expired += 1;
    }
  }

  // Deletion scheduling. `purge_after IS NULL` is the idempotence guard, and it
  // is also what makes a renewal stick: paying clears the stamp, and this
  // query will not rewrite it because a renewed account is no longer expired.
  const pastGrace = await db
    .prepare(
      `${SELECT_CANDIDATE}
        WHERE o.billing_status = 'expired'
          AND o.purge_after IS NULL
          AND o.current_period_end IS NOT NULL
          AND o.current_period_end <= ?
        ORDER BY o.current_period_end ASC
        LIMIT ?`
    )
    .bind(now - RENEWAL_GRACE_MS, limit)
    .all<CandidateRow>();

  result.candidates.deletion = (pastGrace.results ?? []).map(asCandidate);

  if (!dryRun) {
    for (const candidate of result.candidates.deletion) {
      // Seven days out, NOT `deletionScheduledAt(periodEnd)` — that instant has
      // already passed by the time this pass selects the row, so stamping it
      // would delete the bytes on the next tick and make "scheduled" a lie.
      await db
        .prepare(
          `UPDATE organizations SET purge_after = ?, updated_at = ?
            WHERE id = ? AND billing_status = 'expired' AND purge_after IS NULL`
        )
        .bind(now + RENEWAL_NOTICE_MS, now, candidate.orgId)
        .run();
      result.deletionsScheduled += 1;

      // Loud, and at warn. This is the line somebody reads when asked why an
      // account's data went, and it has to carry enough to answer without a
      // database query.
      console.log(
        JSON.stringify({
          level: "warn",
          message: "billing expiry scheduled deletion",
          orgId: candidate.orgId,
          plan: candidate.plan,
          periodEndedAt: new Date(candidate.periodEnd).toISOString(),
          purgeAfter: new Date(now + RENEWAL_NOTICE_MS).toISOString(),
          notifiable: candidate.ownerEmail !== null,
        })
      );
    }
  }

  // The purge. **This is the end of the lifecycle**, and its absence is why the
  // third email promised a deletion nothing performed: 0027 wrote `purge_after`
  // and every consumer of that column name in this codebase reads
  // `users.purge_after`, not the organization's.
  //
  // It lives here rather than in `jobs/pending-deletions.ts` so that one file
  // owns one lifecycle end to end — the clock that scheduled the deletion is
  // the clock that performs it, under the same flag, with no second job to fall
  // out of step.
  //
  // Requires `files`, so a deployment that did not pass a bucket reports the due
  // accounts and deletes nothing rather than half-finishing.
  if (deps.files !== undefined) {
    const due = await db
      .prepare(
        `${SELECT_CANDIDATE}
          WHERE o.purge_after IS NOT NULL
            AND o.purge_after <= ?
            AND o.purged_at IS NULL
          ORDER BY o.purge_after ASC
          LIMIT ?`
      )
      .bind(now, limit)
      .all<CandidateRow>();

    result.candidates.purge = (due.results ?? []).map(asCandidate);

    if (!dryRun) {
      // Resolved once for the whole batch rather than per account: it is the
      // same answer for all of them and the catalogue read is not free.
      const fallbackPlan = defaultPlanId(await loadCatalogue(db, now));

      for (const candidate of result.candidates.purge) {
        try {
          // Re-read the stamp inside the loop. These rows were selected at the
          // top of a job that may have been running for a while, and a renewal
          // that landed in between must win — destroying the files of somebody
          // who paid thirty seconds ago is the one unrecoverable mistake this
          // job can make. The same guard `expireUnclaimedWorkspaces` uses.
          const stillDue = await db
            .prepare(
              `SELECT 1 AS ok FROM organizations
                WHERE id = ? AND purge_after IS NOT NULL AND purge_after <= ?`
            )
            .bind(candidate.orgId, now)
            .first<{ ok: number }>();
          if (stillDue === null) {
            result.purgeSkipped += 1;
            continue;
          }

          const workspaces = await db
            .prepare(`SELECT id FROM workspaces WHERE org_id = ?`)
            .bind(candidate.orgId)
            .all<{ id: string }>();

          let objects = 0;
          for (const workspace of workspaces.results ?? []) {
            // R2 before D1, per the cascade's own contract: the rows are the
            // only record of which objects exist, so losing them first orphans
            // bytes nothing can ever find again.
            const cascade = await deleteWorkspaceCascade(db, deps.files, workspace.id);
            objects += cascade.objectsDeleted;
          }

          // The organization row survives — see migration 0028. Reset rather
          // than removed: the audit trail keeps resolving, the person can still
          // sign in, and a repurchase reuses this account instead of building a
          // second one beside the corpse of the first.
          //
          // `plan` returns to the default because a workspace created after this
          // would otherwise be handed the paid tier's quota for nothing.
          // `current_period_end` is deliberately LEFT as it was: it is the date
          // the shell screen tells the person their plan ended.
          await db
            .prepare(
              `UPDATE organizations
                  SET purged_at = ?, purge_after = NULL, billing_status = 'canceled',
                      plan = ?, storage_bytes_used = 0, file_count = 0, updated_at = ?
                WHERE id = ?`
            )
            .bind(now, fallbackPlan, now, candidate.orgId)
            .run();

          result.purged += 1;
          result.objectsDeleted += objects;

          await recordPurge(db, candidate, {
            workspaces: (workspaces.results ?? []).length,
            objectsDeleted: objects,
            now,
          });

          // At warn, carrying both dates, because this is the line somebody
          // reads when a customer asks where their files went.
          console.log(
            JSON.stringify({
              level: "warn",
              message: "billing purge removed an account's data",
              orgId: candidate.orgId,
              workspaces: (workspaces.results ?? []).length,
              objectsDeleted: objects,
              periodEndedAt: new Date(candidate.periodEnd).toISOString(),
              purgedAt: new Date(now).toISOString(),
            })
          );
        } catch (err) {
          // One bad account must not stop the batch. It keeps its stamp and is
          // retried next tick, which is right for a transient R2 or D1 failure.
          result.purgeFailed += 1;
          console.log(
            JSON.stringify({
              level: "error",
              message: "billing purge failed for one account",
              orgId: candidate.orgId,
              reason: err instanceof Error ? err.message : String(err),
            })
          );
        }
      }
    }
  }

  /* ------------------------- notification passes ------------------------- */

  // Reminder. The only pass with no state change of its own, so the
  // `notifications_sent` row is the entire record that it happened.
  const expiringSoon = await db
    .prepare(
      `${SELECT_CANDIDATE}
        WHERE o.billing_status = 'active'
          AND o.current_period_end IS NOT NULL
          AND o.current_period_end > ?
          AND o.current_period_end <= ?
          AND NOT EXISTS (
                SELECT 1 FROM notifications_sent n
                 WHERE n.org_id = o.id
                   AND n.kind = 'renewal_reminder'
                   AND n.period_end = o.current_period_end)
        ORDER BY o.current_period_end ASC
        LIMIT ?`
    )
    .bind(now, now + RENEWAL_REMINDER_MS, limit)
    .all<CandidateRow>();

  result.candidates.reminder = (expiringSoon.results ?? []).map(asCandidate);

  for (const candidate of result.candidates.reminder) {
    const sent = await notifyOnce(deps, result, candidate, "renewal_reminder", (config, to) =>
      sendRenewalReminderEmail(config, {
        to,
        planName: candidate.planName,
        periodEndDate: formatPeriodDate(candidate.periodEnd),
        renewUrl: renewUrl(deps.dashboardUrl, candidate),
      })
    );
    if (sent) result.reminded += 1;
  }

  // Expiry notice. Selected on the expired state rather than on having just
  // changed it, so a send that failed an hour ago is retried now.
  const needExpiryNotice = await db
    .prepare(
      `${SELECT_CANDIDATE}
        WHERE o.billing_status = 'expired'
          AND o.current_period_end IS NOT NULL
          AND NOT EXISTS (
                SELECT 1 FROM notifications_sent n
                 WHERE n.org_id = o.id
                   AND n.kind = 'expired'
                   AND n.period_end = o.current_period_end)
        ORDER BY o.current_period_end ASC
        LIMIT ?`
    )
    .bind(limit)
    .all<CandidateRow>();

  for (const row of needExpiryNotice.results ?? []) {
    const candidate = asCandidate(row);
    await notifyOnce(deps, result, candidate, "expired", (config, to) =>
      sendPlanExpiredEmail(config, {
        to,
        planName: candidate.planName,
        periodEndDate: formatPeriodDate(candidate.periodEnd),
        graceEndDate: formatPeriodDate(deletionScheduledAt(candidate.periodEnd)),
        renewUrl: renewUrl(deps.dashboardUrl, candidate),
      })
    );
  }

  // Deletion notice. Selected on the stamp existing, which means it is sent
  // once the schedule is real — and never for an account that renewed, because
  // renewing cleared the stamp before this pass could see it.
  const needDeletionNotice = await db
    .prepare(
      `${SELECT_CANDIDATE}
        WHERE o.purge_after IS NOT NULL
          AND o.current_period_end IS NOT NULL
          AND NOT EXISTS (
                SELECT 1 FROM notifications_sent n
                 WHERE n.org_id = o.id
                   AND n.kind = 'deletion_scheduled'
                   AND n.period_end = o.current_period_end)
        ORDER BY o.purge_after ASC
        LIMIT ?`
    )
    .bind(limit)
    .all<CandidateRow>();

  for (const row of needDeletionNotice.results ?? []) {
    const candidate = asCandidate(row);
    await notifyOnce(deps, result, candidate, "deletion_scheduled", (config, to) =>
      sendDeletionScheduledEmail(config, {
        to,
        planName: candidate.planName,
        periodEndDate: formatPeriodDate(candidate.periodEnd),
        renewUrl: renewUrl(deps.dashboardUrl, candidate),
        dashboardUrl: `${deps.dashboardUrl}/app`,
      })
    );
  }

  if (dryRun) {
    const total =
      result.candidates.reminder.length +
      result.candidates.expiry.length +
      result.candidates.deletion.length +
      result.candidates.purge.length;
    if (total > 0) {
      // One line, at warn, carrying every account. This is the artifact
      // somebody reads before setting BILLING_EXPIRY_ENABLED, so it has to be
      // complete rather than a count.
      console.log(
        JSON.stringify({
          level: "warn",
          message: "renewal ladder candidates (dry run - nothing written or sent)",
          reminder: result.candidates.reminder,
          expiry: result.candidates.expiry,
          deletion: result.candidates.deletion,
          purge: result.candidates.purge,
        })
      );
    }
  }

  return result;
}

/**
 * Write down that an account's data was destroyed.
 *
 * ── Why `admin_actions` and not `audit_events` ─────────────────────────────
 * `audit_events` is workspace-scoped by foreign key, and this operation deletes
 * the workspace — so the one row describing a workspace's destruction is the one
 * row it cannot hold. The same constraint `deleteWorkspaceForUser` and the
 * sandbox sweep both document. `workspace_id` is NULL here for the same reason:
 * it is a foreign key to a row that no longer exists.
 *
 * ── Why `actor_role = 'system'` ────────────────────────────────────────────
 * Migration 0011 defined that value — *"not a role and cannot log in; it is how
 * scheduled work identifies itself, so that an expiry sweep is not recorded as a
 * person"* — and nothing has ever written it. This is its first legitimate use.
 * It goes through a direct insert rather than `AuditedAdminAccess.recordFleet`
 * because that class exists to stop an *admin area* acting without a record, and
 * takes an admin to do it; a cron has no actor to supply.
 *
 * ── Why a failure here does not fail the purge ─────────────────────────────
 * The bytes are already gone by the time this runs, so throwing would not unwind
 * anything — it would only re-run a cascade that has nothing left to delete.
 * The durable fact is `organizations.purged_at`, written in the same pass on a
 * row that survives; this is the human-readable account of it, and a failure to
 * write it is logged at error rather than swallowed.
 */
async function recordPurge(
  db: D1Database,
  candidate: RenewalCandidate,
  facts: { workspaces: number; objectsDeleted: number; now: number }
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO admin_actions
           (id, actor_id, actor_email, actor_role, action, workspace_id,
            target_type, target_id, reason, result, source_ip, request_id,
            metadata, created_at)
         VALUES (?, 'system', 'system', 'system', 'billing.purged', NULL,
                 'organization', ?, ?, 'success', NULL, NULL, ?, ?)`
      )
      .bind(
        newId("adminAction", facts.now),
        candidate.orgId,
        "Plan lapsed. The 7-day grace and the 7-day deletion notice both elapsed with no renewal.",
        JSON.stringify({
          plan: candidate.plan,
          workspaces: facts.workspaces,
          objectsDeleted: facts.objectsDeleted,
          periodEndedAt: new Date(candidate.periodEnd).toISOString(),
          purgedAt: new Date(facts.now).toISOString(),
          // Whether the three warnings could actually reach anybody. A
          // destruction nobody could be told about is the case an operator
          // most needs to find later.
          ownerReachable: candidate.ownerEmail !== null,
        }),
        facts.now
      )
      .run();
  } catch (err) {
    console.log(
      JSON.stringify({
        level: "error",
        message: "billing purge could not be recorded",
        orgId: candidate.orgId,
        reason: err instanceof Error ? err.message : String(err),
      })
    );
  }
}

/**
 * Send one message, at most once per account per period.
 *
 * Claims the slot **after** the provider accepts, not before. Claiming first
 * would record a message that may never have left, and the one thing worse than
 * a duplicate "your data is scheduled for deletion" is a missing one.
 *
 * The insert can still lose a race with a concurrent tick, which is exactly
 * what the unique index is for: the second insert throws, is swallowed here,
 * and the only cost is one duplicate message rather than a failed run.
 */
async function notifyOnce(
  deps: RenewalDeps,
  result: RenewalResult,
  candidate: RenewalCandidate,
  kind: NotificationKind,
  send: (config: EmailConfig, to: string) => Promise<unknown>
): Promise<boolean> {
  if (deps.dryRun ?? true) return false;

  if (candidate.ownerEmail === null) {
    // The state change already happened; only the message is lost. Recorded at
    // warn because an account being swept with nobody reachable to tell is a
    // fact an operator should see, not a silent success.
    result.unreachable += 1;
    console.log(
      JSON.stringify({
        level: "warn",
        message: "renewal notice has no recipient",
        orgId: candidate.orgId,
        kind,
      })
    );
    return false;
  }

  if (deps.email === null) return false;

  try {
    await send(deps.email, candidate.ownerEmail);
  } catch (err) {
    // Left unclaimed on purpose, so the next hourly tick tries again.
    result.emailsFailed += 1;
    console.log(
      JSON.stringify({
        level: "error",
        message: "renewal notice failed to send",
        orgId: candidate.orgId,
        kind,
        reason: err instanceof Error ? err.message : String(err),
      })
    );
    return false;
  }

  try {
    await deps.db
      .prepare(
        `INSERT INTO notifications_sent (id, org_id, kind, period_end, sent_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(
        newId("notification", deps.now),
        candidate.orgId,
        kind,
        candidate.periodEnd,
        deps.now
      )
      .run();
  } catch {
    // A UNIQUE violation means a concurrent tick sent it too. The message is
    // already out; failing the run over the bookkeeping would achieve nothing.
  }

  result.emailsSent += 1;
  return true;
}
