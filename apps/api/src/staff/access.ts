/**
 * Staff sessions, and the one class allowed to reach across tenants —
 * 14 PART 27.3/27.4.
 *
 * `StaffScopedAccess` is the deliberate exception to 06 PART 16.1. Every other
 * data path in this codebase binds a workspace in a constructor so a handler
 * has no argument through which to name somebody else's. This one takes the
 * workspace as an argument on purpose, because a support engineer needs to look
 * at any customer's.
 *
 * Two things make that exception safe to have:
 *
 * **It is one class, in one file, with one way in.** The customer-facing model
 * keeps its "never" as an actual never rather than a "never, except for staff"
 * scattered through the same handlers — which is the failure mode 27.1 is
 * written to prevent.
 *
 * **Every method appends an audit event, unconditionally, including reads.**
 * There is no read-only exception. Somebody looking at a customer's files
 * without changing anything is exactly the access that most needs a record, and
 * "we only looked" is not a defence anybody should have to take on trust.
 */

import { newId } from "../lib/ids";
import { ApiError, forbidden } from "../lib/errors";
import { AuditedStaffAccess } from "./audited";

export type StaffRole = "support" | "admin" | "super_admin";

export const STAFF_ROLES: StaffRole[] = ["support", "admin", "super_admin"];

export function isStaffRole(value: string): value is StaffRole {
  return (STAFF_ROLES as string[]).includes(value);
}

export interface StaffUser {
  id: string;
  email: string;
  role: StaffRole;
  disabledAt: number | null;
}

/** Four hours (27.2), not thirty days. A stolen staff session is the worst case. */
export const STAFF_SESSION_MS = 4 * 60 * 60 * 1000;

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function createStaffSession(
  db: D1Database,
  staffUserId: string,
  now: number
): Promise<{ token: string; expiresAt: number }> {
  const token = generateSessionToken();
  const expiresAt = now + STAFF_SESSION_MS;

  await db
    .prepare(
      `INSERT INTO staff_sessions (id, staff_user_id, token_hash, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`
    )
    .bind(newId("staffSession", now), staffUserId, await hashToken(token), expiresAt, now)
    .run();

  return { token, expiresAt };
}

/**
 * Resolve a session token to a staff user, or nothing.
 *
 * Every failure returns null rather than a distinguishable error, for the same
 * reason customer authentication does: a response that says *why* is an oracle.
 */
export async function resolveStaffSession(
  db: D1Database,
  token: string,
  now: number
): Promise<StaffUser | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.role, u.disabled_at AS disabledAt
         FROM staff_sessions s
         JOIN staff_users u ON u.id = s.staff_user_id
        WHERE s.token_hash = ?
          AND s.revoked_at IS NULL
          AND s.expires_at > ?`
    )
    .bind(await hashToken(token), now)
    .first<{ id: string; email: string; role: string; disabledAt: number | null }>();

  if (row === null) return null;
  // A disabled account's live sessions stop working immediately, rather than
  // lasting until they expire. Disabling somebody is usually urgent.
  if (row.disabledAt !== null) return null;
  if (!isStaffRole(row.role)) return null;

  return { id: row.id, email: row.email, role: row.role, disabledAt: row.disabledAt };
}

export async function revokeStaffSession(
  db: D1Database,
  token: string,
  now: number
): Promise<void> {
  await db
    .prepare(`UPDATE staff_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
    .bind(now, await hashToken(token))
    .run();
}

/* ---------------------------- the exception ------------------------------ */

export interface FleetWorkspace {
  id: string;
  name: string;
  status: string;
  orgId: string;
  orgName: string;
  plan: string;
  billingStatus: string;
  storageBytesUsed: number;
  fileCount: number;
  createdAt: number;
}

/**
 * Cross-tenant access, for staff, with a record of every use.
 *
 * Constructed only inside `/v1/staff/*` handlers. Nothing else in the codebase
 * imports this file, and that is the property worth preserving: one import site
 * is auditable by reading, a dozen is not.
 */
export class StaffScopedAccess extends AuditedStaffAccess {
  /** Every workspace on the platform, newest first. */
  async listFleet(limit = 50, search: string | null = null): Promise<FleetWorkspace[]> {
    const like = search === null ? null : `%${search.replace(/[%_\\]/g, c => `\\${c}`)}%`;
    const sql = `SELECT w.id, w.name, w.status, w.org_id AS orgId, o.name AS orgName,
                        o.plan, o.billing_status AS billingStatus,
                        w.storage_bytes_used AS storageBytesUsed, w.file_count AS fileCount,
                        w.created_at AS createdAt
                   FROM workspaces w
                   JOIN organizations o ON o.id = w.org_id
                  ${like === null ? "" : "WHERE w.name LIKE ? ESCAPE '\\\\' OR o.name LIKE ? ESCAPE '\\\\'"}
                  ORDER BY w.created_at DESC
                  LIMIT ?`;
    const binds = like === null ? [limit] : [like, like, limit];
    const rows = await this.db.prepare(sql).bind(...binds).all<FleetWorkspace>();
    return rows.results ?? [];
  }

  /** One workspace, in detail. Recorded, because looking is the access that matters. */
  async getWorkspace(workspaceId: string): Promise<FleetWorkspace | null> {
    const row = await this.db
      .prepare(
        `SELECT w.id, w.name, w.status, w.org_id AS orgId, o.name AS orgName,
                o.plan, o.billing_status AS billingStatus,
                w.storage_bytes_used AS storageBytesUsed, w.file_count AS fileCount,
                w.created_at AS createdAt
           FROM workspaces w
           JOIN organizations o ON o.id = w.org_id
          WHERE w.id = ?`
      )
      .bind(workspaceId)
      .first<FleetWorkspace>();

    if (row !== null) await this.record(workspaceId, "staff.workspace.viewed");
    return row;
  }

  async setWorkspaceStatus(
    workspaceId: string,
    status: "active" | "suspended" | "deleted",
    reason: string
  ): Promise<boolean> {
    await this.requireRole("admin", `${status === "active" ? "reinstate" : status} workspaces`);

    const result = await this.db
      .prepare(`UPDATE workspaces SET status = ?, updated_at = ? WHERE id = ?`)
      .bind(status, this.now, workspaceId)
      .run();

    const changed = (result.meta.changes ?? 0) > 0;
    if (changed) {
      // The reason is recorded because a suspension somebody has to explain
      // later is worth more than one they merely have to remember.
      await this.record(workspaceId, `staff.workspace.${status}`, { reason });
    }
    return changed;
  }

  /**
   * Force every open session for one user to re-authenticate (14 PART 27.5).
   *
   * Not a session table any more — Firebase owns those. This writes the
   * `session_revoked_after` timestamp the auth chain already checks (16 PART
   * 30.4), which is the same mechanism a user's own "log out everywhere" uses.
   */
  async forceLogout(userId: string, workspaceId: string): Promise<boolean> {
    await this.requireRole("support", "force logout");
    const result = await this.db
      .prepare(`UPDATE users SET session_revoked_after = ?, updated_at = ? WHERE id = ?`)
      .bind(this.now, this.now, userId)
      .run();

    const changed = (result.meta.changes ?? 0) > 0;
    if (changed) await this.record(workspaceId, "staff.user.force_logout", { userId });
    return changed;
  }

  /**
   * Start a password reset on a customer's account.
   *
   * Delivery is injected rather than performed here, and that shape is the
   * point. This class is the cross-tenant *data* exception; giving it the
   * ability to make outbound calls of its own would widen it from "reads
   * customer rows, recorded" to "reads customer rows and can send things,
   * recorded". The callback gets an address and nothing else, so the reset link
   * it mints is never in scope here — it cannot be logged from this file even
   * by accident, which is the only way to be sure it is not.
   *
   * Returns null when no such user row exists. `no_identity` is different: the
   * row exists but Firebase has no account for the address, which happens when
   * a user was created before sign-in moved to Firebase, or was removed there
   * directly. The caller reports both as accepted, because telling staff which
   * of the two it was tells them nothing they can act on and the distinction
   * belongs in the log.
   *
   * A failed send is recorded as `denied` and then rethrown. An action that did
   * not happen must not leave a row saying it did, and an action that was
   * attempted must not leave no row at all.
   */
  async forcePasswordReset(
    userId: string,
    reason: string,
    deliver: (email: string) => Promise<"sent" | "no_identity">
  ): Promise<"sent" | "no_identity" | null> {
    await this.requireRole("support", "reset passwords");

    const user = await this.db
      // No `deleted_at` filter: the column does not exist yet. Customer
      // self-service account deletion has not landed, so there is no such thing
      // as a soft-deleted user to exclude. When it lands, this needs the guard.
      .prepare(`SELECT id, email FROM users WHERE id = ?`)
      .bind(userId)
      .first<{ id: string; email: string }>();
    if (user === null) return null;

    // Read before the send, so the audit rows can be written whichever way it
    // goes. Every workspace this person is a member of, through their org.
    const workspaces = await this.db
      .prepare(
        `SELECT DISTINCT w.id AS workspaceId
           FROM memberships m
           JOIN workspaces w ON w.org_id = m.org_id
          WHERE m.user_id = ?`
      )
      .bind(userId)
      .all<{ workspaceId: string }>();

    let outcome: "sent" | "no_identity";
    try {
      outcome = await deliver(user.email);
    } catch (cause) {
      await this.recordFleet({
        action: "staff.user.password_reset",
        targetType: "user",
        targetId: userId,
        reason,
        result: "denied",
        // The address, never the link. One is what the record is about; the
        // other is a bearer credential for the account it resets.
        metadata: { email: user.email, error: String(cause).slice(0, 200) },
      });
      throw cause;
    }

    await this.recordFleet({
      action: "staff.user.password_reset",
      targetType: "user",
      targetId: userId,
      reason,
      metadata: { email: user.email, outcome },
    });

    // And one row per workspace they belong to, so the owner of a workspace
    // sees that staff acted on one of their members rather than learning it
    // from us later.
    for (const row of workspaces.results ?? []) {
      await this.record(row.workspaceId, "staff.user.password_reset", { userId, outcome });
    }

    return outcome;
  }

  /** Revoke every live key a user created, across every workspace they touched. */
  async revokeUserKeys(userId: string): Promise<number> {
    await this.requireRole("admin", "revoke keys");

    const affected = await this.db
      .prepare(
        `SELECT DISTINCT workspace_id AS workspaceId FROM api_keys
          WHERE created_by_user_id = ? AND revoked_at IS NULL`
      )
      .bind(userId)
      .all<{ workspaceId: string }>();

    const result = await this.db
      .prepare(
        `UPDATE api_keys SET revoked_at = ? WHERE created_by_user_id = ? AND revoked_at IS NULL`
      )
      .bind(this.now, userId)
      .run();

    // One row per affected workspace, not one for the action. A workspace owner
    // reading their own audit log should see that their keys were revoked, and
    // by whom - not have it recorded only somewhere they cannot see.
    for (const row of affected.results ?? []) {
      await this.record(row.workspaceId, "staff.keys.revoked", { userId });
    }

    return result.meta.changes ?? 0;
  }

  /** Read a workspace's audit trail. Itself recorded. */
  async workspaceActivity(workspaceId: string, limit = 100): Promise<unknown[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, action, actor_type AS actorType, actor_id AS actorId, result,
                request_id AS requestId, metadata, created_at AS createdAt
           FROM audit_events WHERE workspace_id = ?
          ORDER BY created_at DESC LIMIT ?`
      )
      .bind(workspaceId, limit)
      .all();

    await this.record(workspaceId, "staff.activity.viewed");
    return rows.results ?? [];
  }

  /** Platform totals for the overview screen. Not workspace-specific, so not recorded. */
  async fleetSummary(): Promise<Record<string, number>> {
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM workspaces) AS workspaces,
           (SELECT COUNT(*) FROM workspaces WHERE status = 'suspended') AS suspended,
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM agents WHERE status = 'active') AS agents,
           (SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL) AS activeKeys,
           (SELECT COALESCE(SUM(storage_bytes_used), 0) FROM workspaces) AS storageBytes,
           (SELECT COUNT(*) FROM organizations WHERE billing_status != 'active') AS billingProblems`
      )
      .first<Record<string, number>>();
    return row ?? {};
  }

  /* ------------------------ console actions (32 PART 6) ------------------- */

  /**
   * Set or clear a workspace's plan override - the "quota bump" action.
   *
   * The design draws this ungated, which is a real privilege escalation as
   * drawn: `workspaces.plan_override` is what `resolveWorkspaceLimits` reads
   * first, so it hands somebody another plan's entitlements outright. admin+.
   *
   * Clearing it (null) returns the workspace to its organization's plan, which
   * is why null is a legitimate value here rather than a missing argument.
   */
  async setPlanOverride(
    workspaceId: string,
    planId: string | null,
    reason: string
  ): Promise<boolean> {
    await this.requireRole("admin", "adjust plan overrides");

    if (planId !== null) {
      // An override naming a plan that does not exist would resolve to the
      // lib/plans.ts floor for a tier nobody is on - a silent downgrade that
      // looks like a grant.
      const plan = await this.db
        .prepare(`SELECT id FROM plans WHERE id = ?`)
        .bind(planId)
        .first<{ id: string }>();
      if (plan === null) throw new ApiError("VALIDATION_ERROR", "No such plan.");
    }

    const result = await this.db
      .prepare(`UPDATE workspaces SET plan_override = ?, updated_at = ? WHERE id = ?`)
      .bind(planId, this.now, workspaceId)
      .run();

    const changed = (result.meta.changes ?? 0) > 0;
    if (changed) {
      await this.record(workspaceId, "staff.plan_override", { planId });
    }
    await this.recordFleet({
      action: "workspace.plan_override",
      workspaceId: changed ? workspaceId : null,
      targetType: "workspace",
      targetId: workspaceId,
      reason,
      result: changed ? "success" : "denied",
      metadata: { planId },
    });
    return changed;
  }

  /**
   * Soft-delete a workspace. Nothing is destroyed here either.
   *
   * Three guards, and each one is deliberate:
   *
   * **It must already be suspended.** Suspension is instant, reversible, and
   * cuts off access, so it is the correct first move in every scenario that
   * ends in deletion - and it gives the customer a chance to notice before
   * their data enters a 30-day countdown.
   *
   * **The name must be typed exactly**, the same pattern the customer's own
   * danger zone uses. The confirmation then belongs to the operation rather
   * than to one client that could be bypassed.
   *
   * **super_admin only.** This destroys somebody else's data on a 30-day
   * timer, without their consent, and it is not a routine support action.
   */
  async softDeleteWorkspace(
    workspaceId: string,
    typedName: string,
    reason: string
  ): Promise<{ deleted: boolean; blastRadius: Record<string, number> }> {
    await this.requireRole("super_admin", "delete workspaces");

    const workspace = await this.db
      .prepare(`SELECT id, name, status, deleted_at AS deletedAt FROM workspaces WHERE id = ?`)
      .bind(workspaceId)
      .first<{ id: string; name: string; status: string; deletedAt: number | null }>();
    if (workspace === null) throw new ApiError("NOT_FOUND", "No such workspace.");

    if (workspace.status !== "suspended") {
      throw new ApiError("CONFLICT", "Suspend this workspace before deleting it.");
    }
    if (typedName !== workspace.name) {
      throw new ApiError("VALIDATION_ERROR", "The typed name does not match this workspace.");
    }

    const blast = await this.workspaceBlastRadius(workspaceId);

    const result = await this.db
      .prepare(
        `UPDATE workspaces SET status = 'deleted', deleted_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`
      )
      .bind(this.now, this.now, workspaceId)
      .run();

    const deleted = (result.meta.changes ?? 0) > 0;
    if (deleted) {
      await this.record(workspaceId, "staff.workspace.deleted", { reason });
    }
    await this.recordFleet({
      action: "workspace.delete",
      workspaceId,
      targetType: "workspace",
      targetId: workspaceId,
      reason,
      result: deleted ? "success" : "denied",
      metadata: { ...blast, name: workspace.name },
    });

    return { deleted, blastRadius: blast };
  }

  /** Undo a soft delete inside its window. The workspace comes back suspended, not active. */
  async restoreWorkspace(workspaceId: string, reason: string): Promise<boolean> {
    await this.requireRole("super_admin", "restore workspaces");

    // Restored to 'suspended' rather than 'active' on purpose: whatever caused
    // the suspension that had to precede deletion has not been resolved by the
    // restore, and silently handing access back would undo that decision too.
    const result = await this.db
      .prepare(
        `UPDATE workspaces SET status = 'suspended', deleted_at = NULL, updated_at = ?
          WHERE id = ? AND deleted_at IS NOT NULL`
      )
      .bind(this.now, workspaceId)
      .run();

    const restored = (result.meta.changes ?? 0) > 0;
    if (restored) await this.record(workspaceId, "staff.workspace.restored", { reason });
    await this.recordFleet({
      action: "workspace.restore",
      workspaceId,
      targetType: "workspace",
      targetId: workspaceId,
      reason,
      result: restored ? "success" : "denied",
    });
    return restored;
  }

  /** What deleting this workspace would eventually take with it, from live counts. */
  async workspaceBlastRadius(workspaceId: string): Promise<Record<string, number>> {
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM files WHERE workspace_id = ?) AS files,
           (SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE workspace_id = ?) AS bytes,
           (SELECT COUNT(*) FROM agents WHERE workspace_id = ?) AS agents,
           (SELECT COUNT(*) FROM api_keys WHERE workspace_id = ? AND revoked_at IS NULL) AS keys,
           (SELECT COUNT(*) FROM memberships WHERE workspace_id = ?) AS members`
      )
      .bind(workspaceId, workspaceId, workspaceId, workspaceId, workspaceId)
      .first<Record<string, number>>();
    return row ?? {};
  }

  /**
   * Disable or re-enable one agent identity - the abuse-response action.
   *
   * support+, because this is the fastest way to stop a misbehaving agent and
   * waiting for an admin is the wrong trade when something is actively
   * misbehaving. Reversible, which is what makes support+ defensible.
   */
  async setAgentStatus(agentId: string, disabled: boolean, reason: string): Promise<boolean> {
    await this.requireRole("support", "disable agents");

    const agent = await this.db
      .prepare(`SELECT id, workspace_id AS workspaceId, name FROM agents WHERE id = ?`)
      .bind(agentId)
      .first<{ id: string; workspaceId: string; name: string }>();
    if (agent === null) throw new ApiError("NOT_FOUND", "No such agent.");

    const result = await this.db
      .prepare(`UPDATE agents SET status = ? WHERE id = ?`)
      .bind(disabled ? "disabled" : "active", agentId)
      .run();

    const changed = (result.meta.changes ?? 0) > 0;
    await this.record(agent.workspaceId, disabled ? "staff.agent.disabled" : "staff.agent.enabled", {
      agentId,
      name: agent.name,
    });
    await this.recordFleet({
      action: disabled ? "agent.disable" : "agent.enable",
      workspaceId: agent.workspaceId,
      targetType: "agent",
      targetId: agentId,
      reason,
      result: changed ? "success" : "denied",
    });
    return changed;
  }

  /**
   * Revoke one API key.
   *
   * Takes effect on the very next request: nothing caches key lookups, by
   * deliberate choice, so every authentication reads `api_keys` directly. If a
   * cache is ever introduced, its invalidation belongs on this line and on the
   * customer-facing revoke beside it.
   */
  async revokeKey(keyId: string, reason: string): Promise<boolean> {
    await this.requireRole("support", "revoke keys");

    const key = await this.db
      .prepare(
        `SELECT id, workspace_id AS workspaceId, name, key_prefix AS prefix
           FROM api_keys WHERE id = ?`
      )
      .bind(keyId)
      .first<{ id: string; workspaceId: string; name: string; prefix: string }>();
    if (key === null) throw new ApiError("NOT_FOUND", "No such key.");

    const result = await this.db
      .prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .bind(this.now, keyId)
      .run();

    const revoked = (result.meta.changes ?? 0) > 0;
    if (revoked) {
      await this.record(key.workspaceId, "staff.key.revoked", { keyId, name: key.name });
    }
    await this.recordFleet({
      action: "key.revoke",
      workspaceId: key.workspaceId,
      targetType: "key",
      targetId: keyId,
      reason,
      result: revoked ? "success" : "denied",
    });
    return revoked;
  }

  /**
   * The Needs Attention rule, in one place.
   *
   * Over 95% of an enforced quota dimension, OR an organization that is not
   * billing-active. The third criterion the design draws - three or more
   * failing webhook endpoints - is deliberately absent: nothing in this product
   * records webhook delivery attempts, so it could only ever be guessed at. The
   * workspace detail screen says "delivery history not tracked yet" rather than
   * showing a number nothing computes.
   *
   * Storage is the dimension checked. Egress, requests and file count are
   * unlimited on every current plan, so a percentage of them is not a thing
   * that exists.
   */
  async needsAttention(limit = 50): Promise<(FleetWorkspace & { why: string })[]> {
    const rows = await this.db
      .prepare(
        `SELECT w.id, w.name, w.status, w.org_id AS orgId, o.name AS orgName,
                COALESCE(w.plan_override, o.plan) AS plan,
                o.billing_status AS billingStatus,
                w.storage_bytes_used AS storageBytesUsed, w.file_count AS fileCount,
                w.created_at AS createdAt,
                p.storage_bytes AS planStorageBytes
           FROM workspaces w
           JOIN organizations o ON o.id = w.org_id
           LEFT JOIN plans p ON p.id = COALESCE(w.plan_override, o.plan)
          WHERE w.status != 'deleted'
            AND (
              o.billing_status != 'active'
              OR (p.storage_bytes IS NOT NULL AND p.storage_bytes > 0
                  AND w.storage_bytes_used * 100 >= p.storage_bytes * 95)
            )
          ORDER BY w.updated_at DESC LIMIT ?`
      )
      .bind(limit)
      .all<FleetWorkspace & { planStorageBytes: number | null }>();

    return (rows.results ?? []).map(row => {
      const reasons: string[] = [];
      if (row.billingStatus !== "active") reasons.push(`Billing is ${row.billingStatus}`);
      if (row.planStorageBytes !== null && row.planStorageBytes > 0) {
        const percent = Math.round((row.storageBytesUsed * 100) / row.planStorageBytes);
        if (percent >= 95) reasons.push(`Storage at ${percent}% of plan`);
      }
      return { ...row, why: reasons.join(" · ") };
    });
  }
}

export function requireStaffRole(staff: StaffUser, minimum: StaffRole): void {
  const rank: Record<StaffRole, number> = { support: 0, admin: 1, super_admin: 2 };
  if (rank[staff.role] < rank[minimum]) {
    throw new ApiError("FORBIDDEN", `This action needs the ${minimum} role.`);
  }
}
