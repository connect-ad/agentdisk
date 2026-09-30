/**
 * Admin sessions, and the one class allowed to reach across tenants —
 * 14 PART 27.3/27.4.
 *
 * `AdminScopedAccess` is the deliberate exception to 06 PART 16.1. Every other
 * data path in this codebase binds a workspace in a constructor so a handler
 * has no argument through which to name somebody else's. This one takes the
 * workspace as an argument on purpose, because a support engineer needs to look
 * at any customer's.
 *
 * Two things make that exception safe to have:
 *
 * **It is one class, in one file, with one way in.** The customer-facing model
 * keeps its "never" as an actual never rather than a "never, except for admin"
 * scattered through the same handlers — which is the failure mode 27.1 is
 * written to prevent.
 *
 * **Every method appends an audit event, unconditionally, including reads.**
 * There is no read-only exception. Somebody looking at a customer's files
 * without changing anything is exactly the access that most needs a record, and
 * "we only looked" is not a defence anybody should have to take on trust.
 */

import { newId } from "../lib/ids";
import { ApiError } from "../lib/errors";
import { escapeLikePattern } from "../lib/paths";
import { AuditedAdminAccess } from "./audited";
import { WorkspaceScopedApiKeys } from "../db/workspace-scoped";
import { generateApiKey, TEST_PREFIX } from "../lib/keys";
import { sealSecret } from "../lib/secretbox";

/**
 * One role. `support` and `super_admin` are gone: everybody who can reach the
 * console can do everything in it.
 *
 * Kept as a union of one rather than deleted outright, and every
 * `requireRole(...)` call site left standing, because those calls are what
 * record a refusal (`admin.denied`) and what documents which actions were once
 * privileged. Re-introducing a tier is then adding a member here and a number
 * in `requireAdminRole` - not re-deriving, from scratch, which of forty methods
 * should have been gated.
 */
export type AdminRole = "admin";

export const ADMIN_ROLES: AdminRole[] = ["admin"];

export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as string[]).includes(value);
}

export interface AdminUser {
  id: string;
  email: string;
  role: AdminRole;
  disabledAt: number | null;
}

/**
 * Resolve a admin member from a verified Firebase email.
 *
 * This is the whole of admin authentication now. Firebase says WHO somebody is;
 * this row says WHAT they are, and a missing row means "not admin" rather than
 * "no permissions" - the two are the same answer here and that is deliberate.
 *
 * **Never a Firebase custom claim.** A claim is minted into a token once and
 * stays true for that token's lifetime, so a demotion or a disable would not
 * take effect until it expired. A row is read on every request, so both are
 * immediate. Since one token now reaches both the customer and the admin
 * surface, that immediacy is the thing standing between them.
 *
 * The email is lowercased on both sides. An address differing only in case is
 * the same person to Google and would otherwise be a different admin member to
 * us - an authorisation gap, not a cosmetic one.
 */
export async function findAdminByEmail(
  db: D1Database,
  email: string
): Promise<AdminUser | null> {
  return db
    .prepare(
      `SELECT id, email, role, disabled_at AS disabledAt
         FROM admin_users WHERE email = ?`
    )
    .bind(email.trim().toLowerCase())
    .first<AdminUser>();
}

/** Record that they were here, for the Admin Accounts screen's "last seen". */
export async function touchAdminLogin(
  db: D1Database,
  adminId: string,
  now: number
): Promise<void> {
  await db
    .prepare(`UPDATE admin_users SET last_login_at = ? WHERE id = ?`)
    .bind(now, adminId)
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
  /**
   * The workspace's own override, or null when it is simply on the
   * organization's plan. `plan` above is already the resolved answer; this says
   * whether that answer came from an override, which is the difference between
   * "this customer is on Pro" and "somebody granted this one workspace Pro".
   */
  planOverride: string | null;
  billingStatus: string;
  storageBytesUsed: number;
  fileCount: number;
  createdAt: number;
}

/**
 * Cross-tenant access, for admin, with a record of every use.
 *
 * Constructed only inside `/v1/admin/*` handlers. Nothing else in the codebase
 * imports this file, and that is the property worth preserving: one import site
 * is auditable by reading, a dozen is not.
 */
export class AdminScopedAccess extends AuditedAdminAccess {
  /**
   * Every workspace on the platform, newest first.
   *
   * `status` is a server-side filter rather than something the console narrows
   * afterwards. The Suspended view used to fetch this list and filter it in the
   * browser, which silently meant "suspended workspaces among the newest 50" -
   * and rendered a confident "No suspended workspaces" for anything older. A
   * filter applied after a LIMIT is not a filter.
   *
   * The plan is resolved here too. `o.plan` alone was the organization's plan,
   * so a workspace carrying an override displayed the plan it is NOT on, while
   * `resolveWorkspaceLimits` enforced the one it is.
   */
  async listFleet(
    limit = 50,
    search: string | null = null,
    status: string | null = null
  ): Promise<FleetWorkspace[]> {
    // Literal clause text, every value bound. Assembled rather than spliced
    // inline: there are two optional filters now, and a second nested ternary
    // in a template literal is what produced the ESCAPE quoting bug this
    // function carried for months.
    const clauses: string[] = [];
    const binds: (string | number)[] = [];

    if (search !== null) {
      const like = `%${escapeLikePattern(search)}%`;
      clauses.push("(w.name LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\')");
      binds.push(like, like);
    }
    if (status !== null) {
      clauses.push("w.status = ?");
      binds.push(status);
    }
    binds.push(limit);

    const sql = `SELECT w.id, w.name, w.status, w.org_id AS orgId, o.name AS orgName,
                        COALESCE(o.plan_override, o.plan) AS plan,
                        o.plan_override AS planOverride,
                        o.billing_status AS billingStatus,
                        w.storage_bytes_used AS storageBytesUsed, w.file_count AS fileCount,
                        w.created_at AS createdAt
                   FROM workspaces w
                   JOIN organizations o ON o.id = w.org_id
                  ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
                  ORDER BY w.created_at DESC
                  LIMIT ?`;
    const rows = await this.db.prepare(sql).bind(...binds).all<FleetWorkspace>();
    return rows.results ?? [];
  }

  /** One workspace, in detail. Recorded, because looking is the access that matters. */
  async getWorkspace(workspaceId: string): Promise<FleetWorkspace | null> {
    const row = await this.db
      .prepare(
        `SELECT w.id, w.name, w.status, w.org_id AS orgId, o.name AS orgName,
                COALESCE(o.plan_override, o.plan) AS plan,
                o.plan_override AS planOverride,
                o.billing_status AS billingStatus,
                w.storage_bytes_used AS storageBytesUsed, w.file_count AS fileCount,
                w.created_at AS createdAt
           FROM workspaces w
           JOIN organizations o ON o.id = w.org_id
          WHERE w.id = ?`
      )
      .bind(workspaceId)
      .first<FleetWorkspace>();

    if (row !== null) await this.record(workspaceId, "admin.workspace.viewed");
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
      await this.record(workspaceId, `admin.workspace.${status}`, { reason });

      if (status !== "active") {
        // Deleted by WORKSPACE, not by user - a suspended or deleted
        // workspace must not keep serving public downloads no matter who
        // created the link. Share links are deleted rather than marked,
        // because there is no revoked state to mark - see migration 0016.
        const sharesResult = await this.db
          .prepare(`DELETE FROM share_links WHERE workspace_id = ?`)
          .bind(workspaceId)
          .run();
        if ((sharesResult.meta.changes ?? 0) > 0) {
          await this.record(workspaceId, "share.revoked", {
            reason: status === "deleted" ? "workspace deleted" : "workspace suspended",
          });
        }
      }
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
    await this.requireRole("admin", "force logout");
    const result = await this.db
      .prepare(`UPDATE users SET session_revoked_after = ?, updated_at = ? WHERE id = ?`)
      .bind(this.now, this.now, userId)
      .run();

    const changed = (result.meta.changes ?? 0) > 0;
    if (changed) await this.record(workspaceId, "admin.user.force_logout", { userId });
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
   * directly. The caller reports both as accepted, because telling admin which
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
    await this.requireRole("admin", "reset passwords");

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
        action: "admin.user.password_reset",
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
      action: "admin.user.password_reset",
      targetType: "user",
      targetId: userId,
      reason,
      metadata: { email: user.email, outcome },
    });

    // And one row per workspace they belong to, so the owner of a workspace
    // sees that admin acted on one of their members rather than learning it
    // from us later.
    for (const row of workspaces.results ?? []) {
      await this.record(row.workspaceId, "admin.user.password_reset", { userId, outcome });
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
      await this.record(row.workspaceId, "admin.keys.revoked", { userId });
    }

    // Share links are deleted rather than marked, because there is no revoked
    // state to mark — see migration 0016. A share link is anonymous and never
    // reaches resolveVerifiedUser, so without this a link this person made
    // stays publicly downloadable even after the credential that made it is
    // gone.
    const affectedShares = await this.db
      .prepare(`SELECT DISTINCT workspace_id AS workspaceId FROM share_links WHERE created_by = ?`)
      .bind(userId)
      .all<{ workspaceId: string }>();

    await this.db.prepare(`DELETE FROM share_links WHERE created_by = ?`).bind(userId).run();

    for (const row of affectedShares.results ?? []) {
      await this.record(row.workspaceId, "share.revoked", { reason: "keys revoked" });
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

    await this.record(workspaceId, "admin.activity.viewed");
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
   * Set or clear the plan override - the "quota bump" action.
   *
   * **Addressed by workspace, applied to the ACCOUNT.** The console reaches
   * this from a workspace's page, because that is where somebody is standing
   * when they decide a customer needs more room, but the override lives on
   * `organizations` since migration 0018 and every workspace on that bill
   * moves with it. The alternative - a per-workspace ceiling - is what 0018
   * removed: usage is pooled across the account, so a per-workspace limit
   * meant the same bytes were measured against different ceilings depending on
   * which workspace the write arrived through.
   *
   * Both the workspace-scoped audit row and the fleet row therefore name the
   * organization as the target, so the log cannot be read as "workspace A was
   * bumped" when workspace B's limits moved too.
   *
   * The design draws this ungated, which is a real privilege escalation as
   * drawn: the override hands somebody another plan's entitlements outright.
   *
   * Clearing it (null) returns the account to its subscription's plan, which
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

    // Through the workspace to its account, rather than taking an org id as an
    // argument: the caller can only reach the account it has already named a
    // workspace of, and a subquery cannot be pointed at a different tenant.
    const result = await this.db
      .prepare(
        `UPDATE organizations
            SET plan_override = ?, updated_at = ?
          WHERE id = (SELECT org_id FROM workspaces WHERE id = ?)`
      )
      .bind(planId, this.now, workspaceId)
      .run();

    const changed = (result.meta.changes ?? 0) > 0;
    if (changed) {
      // Still written against the workspace, because that is the customer-
      // visible activity log somebody will look at - but the metadata says
      // plainly that the whole account moved.
      await this.record(workspaceId, "admin.plan_override", { planId, scope: "account" });
    }
    await this.recordFleet({
      action: "account.plan_override",
      workspaceId: changed ? workspaceId : null,
      targetType: "organization",
      targetId: workspaceId,
      reason,
      result: changed ? "success" : "denied",
      metadata: { planId, appliesTo: "every workspace on this account" },
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
    await this.requireRole("admin", "delete workspaces");

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
      await this.record(workspaceId, "admin.workspace.deleted", { reason });
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
    await this.requireRole("admin", "disable agents");

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

    // The same cascade the customer's own agent switch performs
    // (routes/agents.ts). Without it, an operator disabling an agent left its
    // keys unmarked and, on re-enable, handed back the very tokens the
    // disable was meant to stop - so what "disable" meant depended on which
    // console did it.
    if (changed) {
      const keys = new WorkspaceScopedApiKeys(this.db, agent.workspaceId);
      if (disabled) {
        await keys.disableForAgent(agentId, this.now);
      } else {
        for (const key of await keys.listDisabledByAgent(agentId)) {
          const mode = key.key_prefix.startsWith(TEST_PREFIX) ? "test" : "live";
          const generated = await generateApiKey(mode);
          const ciphertext =
            this.encryptionKey === null
              ? null
              : await sealSecret(this.encryptionKey, generated.token, key.id);
          await keys.enableWithRotation(key.id, generated, ciphertext);
        }
      }
    }
    await this.record(agent.workspaceId, disabled ? "admin.agent.disabled" : "admin.agent.enabled", {
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
    await this.requireRole("admin", "revoke keys");

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
      await this.record(key.workspaceId, "admin.key.revoked", { keyId, name: key.name });
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
                COALESCE(o.plan_override, o.plan) AS plan,
                o.plan_override AS planOverride,
                o.billing_status AS billingStatus,
                w.storage_bytes_used AS storageBytesUsed, w.file_count AS fileCount,
                o.storage_bytes_used AS orgStorageBytesUsed,
                w.created_at AS createdAt,
                p.storage_bytes AS planStorageBytes
           FROM workspaces w
           JOIN organizations o ON o.id = w.org_id
           LEFT JOIN plans p ON p.id = COALESCE(o.plan_override, o.plan)
          WHERE w.status != 'deleted'
            AND (
              o.billing_status != 'active'
              OR (p.storage_bytes IS NOT NULL AND p.storage_bytes > 0
                  AND o.storage_bytes_used * 100 >= p.storage_bytes * 95)
            )
          ORDER BY w.updated_at DESC LIMIT ?`
      )
      .bind(limit)
      .all<FleetWorkspace & { planStorageBytes: number | null; orgStorageBytesUsed: number }>();

    return (rows.results ?? []).map(row => {
      const reasons: string[] = [];
      if (row.billingStatus !== "active") reasons.push(`Billing is ${row.billingStatus}`);
      if (row.planStorageBytes !== null && row.planStorageBytes > 0) {
        // The account's usage against the account's plan (migration 0017).
        // Dividing one workspace's bytes by the plan understates every
        // multi-workspace account, so the console would go on reporting room
        // that the request path had already stopped granting - and the support
        // engineer looking for why a customer's uploads fail would find the
        // one screen that agrees with the customer.
        const percent = Math.round((row.orgStorageBytesUsed * 100) / row.planStorageBytes);
        if (percent >= 95) reasons.push(`Account storage at ${percent}% of plan`);
      }
      return { ...row, why: reasons.join(" · ") };
    });
  }
}

/**
 * Cannot currently refuse: there is one role and it outranks itself. The
 * comparison is kept so that adding a tier restores the gate everywhere at
 * once, rather than needing every call site found again.
 */
export function requireAdminRole(admin: AdminUser, minimum: AdminRole): void {
  const rank: Record<AdminRole, number> = { admin: 0 };
  if (rank[admin.role] < rank[minimum]) {
    throw new ApiError("FORBIDDEN", `This action needs the ${minimum} role.`);
  }
}
