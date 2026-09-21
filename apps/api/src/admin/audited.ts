/**
 * The audit discipline every admin area inherits — 32 PART 9.
 *
 * ── Why this was extracted ──────────────────────────────────────────────────
 * `AdminScopedAccess` began as one class holding both the cross-tenant queries
 * and the audit plumbing underneath them. That was right while the console
 * reached workspaces and nothing else. It stopped being right once the console
 * grew users, plans, billing, admin accounts and an audit screen of its own:
 * one class would have run to well past a thousand lines, which is the point at
 * which nobody reads the audit methods again to check they are still
 * unconditional.
 *
 * So the *discipline* lives here and the *queries* live in area classes that
 * extend it. What did not change is the property that made the exception safe
 * to have in the first place: `record`, `recordFleet` and `requireRole` are
 * protected, every area class is constructed only inside a `/v1/admin/*`
 * handler, and no area class can perform an action without inheriting the
 * machinery that writes it down.
 *
 * ── The two logs, and why there are two ─────────────────────────────────────
 * `record` writes the workspace-scoped `audit_events` row the CUSTOMER can see
 * in their own activity log — so somebody whose data admin touched can find
 * that out without being told. `recordFleet` writes the `admin_actions` row
 * that exists whether or not a workspace was involved at all. An action
 * touching a live workspace writes both. One that does not — a user lookup, a
 * plan edit, creating a admin account — writes only the second. Migration 0011
 * carries the full reasoning for why these cannot be one table.
 *
 * Both are awaited rather than fired into `waitUntil`, unlike the
 * customer-facing audit helper. The asymmetry is deliberate: a customer's
 * upload should not wait on a log write, but a admin action that could not be
 * recorded should not be reported as having happened.
 */

import { newId } from "../lib/ids";
import { forbidden } from "../lib/errors";
import type { AdminRole, AdminUser } from "./access";

/**
 * One role, so nothing outranks anything. Kept as a map rather than deleted
 * with the comparison it feeds, because restoring a tier should be adding a
 * line here - not rediscovering which of forty methods were privileged.
 */
const RANK: Record<AdminRole, number> = { admin: 0 };

export interface FleetRecord {
  action: string;
  workspaceId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  reason?: string | null;
  result?: "success" | "denied";
  metadata?: Record<string, string | number | boolean | null>;
}

export abstract class AuditedAdminAccess {
  constructor(
    protected readonly db: D1Database,
    protected readonly admin: AdminUser,
    protected readonly requestId: string,
    protected readonly now: number,
    /**
     * The caller's address, for the audit screen's Source IP column.
     *
     * Null is a legitimate value rather than a failure: a request that reached
     * the Worker without `cf-connecting-ip` genuinely has no address we can
     * vouch for, and inventing one — falling back to a header a client can set
     * — would put a forgeable value in an accountability log, which is worse
     * than an honest blank.
     */
    protected readonly sourceIp: string | null = null
  ) {}

  /** The workspace-scoped row, visible to the customer whose workspace it is. */
  protected async record(
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
         VALUES (?, ?, 'admin', ?, ?, 'workspace', ?, ?, ?, NULL, ?, ?, ?)`
      )
      .bind(
        newId("auditEvent", this.now),
        workspaceId,
        this.admin.id,
        action,
        workspaceId,
        result,
        this.sourceIp,
        this.requestId,
        JSON.stringify({ ...metadata, adminEmail: this.admin.email, adminRole: this.admin.role }),
        this.now
      )
      .run();
  }

  /** The fleet-wide row, which exists whether or not a workspace does. */
  protected async recordFleet(options: FleetRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO admin_actions
           (id, actor_id, actor_email, actor_role, action, workspace_id,
            target_type, target_id, reason, result, source_ip, request_id,
            metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        newId("adminAction", this.now),
        this.admin.id,
        this.admin.email,
        this.admin.role,
        options.action,
        options.workspaceId ?? null,
        options.targetType ?? null,
        options.targetId ?? null,
        options.reason ?? null,
        options.result ?? "success",
        this.sourceIp,
        this.requestId,
        JSON.stringify(options.metadata ?? {}),
        this.now
      )
      .run();
  }

  /**
   * Refuse below a role — and write down that we refused.
   *
   * The denial is recorded, not just thrown. A support engineer repeatedly
   * attempting super_admin actions is a fact worth having, and a log that holds
   * only successful actions cannot show it. Recorded before the throw, because
   * after it there is no "after".
   */
  protected async requireRole(minimum: AdminRole, action: string): Promise<void> {
    if (RANK[this.admin.role] >= RANK[minimum]) return;
    await this.recordFleet({
      action: `admin.denied`,
      result: "denied",
      metadata: { attempted: action, required: minimum, held: this.admin.role },
    });
    throw forbidden(`The ${this.admin.role} role cannot ${action}.`);
  }

  /** Whether this actor holds at least `minimum`. For shaping a response, never for gating one. */
  protected holds(minimum: AdminRole): boolean {
    return RANK[this.admin.role] >= RANK[minimum];
  }
}
