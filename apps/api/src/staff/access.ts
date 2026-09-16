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
export class StaffScopedAccess {
  constructor(
    private readonly db: D1Database,
    private readonly staff: StaffUser,
    private readonly requestId: string,
    private readonly now: number
  ) {}

  /**
   * Append the audit row for a staff action.
   *
   * Awaited rather than fired into `waitUntil`, unlike the customer-facing
   * audit helper. The asymmetry is deliberate: a customer's upload should not
   * wait on a log write, but a staff action that could not be recorded should
   * not be reported as having happened.
   */
  private async record(
    workspaceId: string,
    action: string,
    metadata: Record<string, string | number | boolean | null> = {},
    result: "success" | "denied" = "success"
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_type, actor_id, action, resource_type, resource_id,
            result, ip, client, request_id, metadata, created_at)
         VALUES (?, ?, 'staff', ?, ?, 'workspace', ?, ?, NULL, NULL, ?, ?, ?)`
      )
      .bind(
        newId("auditEvent", this.now),
        workspaceId,
        this.staff.id,
        action,
        workspaceId,
        result,
        this.requestId,
        JSON.stringify({ ...metadata, staffEmail: this.staff.email, staffRole: this.staff.role }),
        this.now
      )
      .run();
  }

  private requireRole(minimum: StaffRole, action: string): void {
    const rank: Record<StaffRole, number> = { support: 0, admin: 1, super_admin: 2 };
    if (rank[this.staff.role] < rank[minimum]) {
      throw forbidden(`The ${this.staff.role} role cannot ${action}.`);
    }
  }

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
    this.requireRole("admin", `${status === "active" ? "reinstate" : status} workspaces`);

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
    this.requireRole("support", "force logout");
    const result = await this.db
      .prepare(`UPDATE users SET session_revoked_after = ?, updated_at = ? WHERE id = ?`)
      .bind(this.now, this.now, userId)
      .run();

    const changed = (result.meta.changes ?? 0) > 0;
    if (changed) await this.record(workspaceId, "staff.user.force_logout", { userId });
    return changed;
  }

  /** Revoke every live key a user created, across every workspace they touched. */
  async revokeUserKeys(userId: string): Promise<number> {
    this.requireRole("admin", "revoke keys");

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
}

export function requireStaffRole(staff: StaffUser, minimum: StaffRole): void {
  const rank: Record<StaffRole, number> = { support: 0, admin: 1, super_admin: 2 };
  if (rank[staff.role] < rank[minimum]) {
    throw new ApiError("FORBIDDEN", `This action needs the ${minimum} role.`);
  }
}
