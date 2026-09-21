/**
 * Admin accounts — 32 PART 6, as amended by migration 0014.
 *
 * ── An account is an email address and a role ──────────────────────────────
 * There is no credential to mint any more. Admin sign in through Firebase like
 * everybody else, so adding an administrator is adding a row here, and that row
 * is the only thing that separates a admin member from any other signed-in
 * customer. Nothing is shown once, because nothing secret is created.
 *
 * That also dissolves the rule `CLAUDE.md` recorded - *the first admin account
 * cannot come from the API* - rather than softening it. The rule existed
 * because an endpoint that mints a working admin credential can be tricked into
 * minting one. This endpoint mints nothing: it grants an existing, independently
 * authenticated identity a role. The first row is seeded by the migration,
 * which is the only place it could come from now.
 *
 * ── Never deleted, only disabled ───────────────────────────────────────────
 * Unchanged, and for the unchanged reason: the audit log has to keep resolving
 * a historical actor, and `admin_actions` denormalises the email and role *at
 * the time* precisely so a later edit here cannot rewrite what somebody did.
 */

import { AuditedAdminAccess } from "./audited";
import { ApiError, forbidden, validationError } from "../lib/errors";
import { newId } from "../lib/ids";
import { ADMIN_ROLES, type AdminRole } from "./access";

export interface AdminAccountRow {
  id: string;
  email: string;
  role: string;
  disabledAt: number | null;
  /** Set by requireAdmin on every authenticated request, not by a login route. */
  lastLoginAt: number | null;
  createdAt: number;
  invitedBy: string | null;
}

export class AdminAccountAccess extends AuditedAdminAccess {
  async list(): Promise<AdminAccountRow[]> {
    await this.requireRole("admin", "manage admin accounts");

    const rows = await this.db
      .prepare(
        `SELECT id, email, role, disabled_at AS disabledAt, last_login_at AS lastLoginAt,
                created_at AS createdAt, invited_by AS invitedBy
           FROM admin_users ORDER BY created_at ASC`
      )
      .all<AdminAccountRow>();

    await this.recordFleet({ action: "admin.list", metadata: { count: rows.results?.length ?? 0 } });
    return rows.results ?? [];
  }

  /**
   * Grant an email address a admin role.
   *
   * Whoever holds that address at this Firebase project becomes admin the next
   * time they sign in - there is no invitation to accept and no credential to
   * deliver. Two consequences worth being deliberate about:
   *
   * The address is stored lowercase, and matched lowercase, because it is now
   * an authorisation key rather than a label. `Owner@x.com` and `owner@x.com`
   * are one person to Google and must be one row here.
   *
   * The account need not exist yet. Adding an address nobody has registered is
   * legitimate - it is how you onboard somebody before their first sign-in -
   * but it does mean the row is a standing grant to whoever can prove that
   * address to Firebase. Adding an address you do not control is the mistake
   * this cannot detect, which is why it is super_admin-only and audited.
   */
  async create(
    email: string,
    role: string,
    reason: string
  ): Promise<AdminAccountRow> {
    await this.requireRole("admin", "create admin accounts");

    const normalised = email.trim().toLowerCase();
    if (normalised === "" || !normalised.includes("@")) {
      throw validationError("A admin email address is required.");
    }
    if (!ADMIN_ROLES.includes(role as AdminRole)) {
      throw validationError(`A role must be one of ${ADMIN_ROLES.join(", ")}.`);
    }

    const existing = await this.db
      .prepare(`SELECT id FROM admin_users WHERE email = ?`)
      .bind(normalised)
      .first<{ id: string }>();
    if (existing !== null) {
      throw new ApiError("CONFLICT", "That address already has a admin role.");
    }

    const id = newId("adminUser", this.now);
    await this.db
      .prepare(
        `INSERT INTO admin_users
           (id, email, role, disabled_at, last_login_at, created_at, invited_by)
         VALUES (?, ?, ?, NULL, NULL, ?, ?)`
      )
      .bind(id, normalised, role, this.now, this.admin.id)
      .run();

    await this.recordFleet({
      action: "admin.create",
      targetType: "admin",
      targetId: id,
      reason,
      metadata: { email: normalised, role },
    });

    return {
      id,
      email: normalised,
      role,
      disabledAt: null,
      lastLoginAt: null,
      createdAt: this.now,
      invitedBy: this.admin.id,
    };
  }

  /**
   * Disable or re-enable an account.
   *
   * Takes effect on their very next request. `requireAdmin` reads this column
   * on every call, so there is no window at all — which is strictly better than
   * the four-hour session this replaced, where a disable could not reach a
   * session already open.
   */
  async setDisabled(adminId: string, disabled: boolean, reason: string): Promise<boolean> {
    await this.requireRole("admin", "disable admin accounts");

    if (adminId === this.admin.id && disabled) {
      // Disabling yourself removes the only role that can re-enable anyone, and
      // there may be no other super_admin. The recovery path would be the
      // provisioning script and a database write.
      throw forbidden("You cannot disable your own admin account.");
    }

    const result = await this.db
      .prepare(
        disabled
          ? `UPDATE admin_users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`
          : `UPDATE admin_users SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL`
      )
      .bind(...(disabled ? [this.now, adminId] : [adminId]))
      .run();

    const changed = (result.meta.changes ?? 0) > 0;

    await this.recordFleet({
      action: disabled ? "admin.disable" : "admin.enable",
      targetType: "admin",
      targetId: adminId,
      reason,
      result: changed ? "success" : "denied",
    });
    return changed;
  }

  /**
   * Change a admin member's role.
   *
   * Refuses to change your own, in either direction. Demoting yourself can
   * strip the last super_admin; promoting yourself is a privilege escalation
   * that would need no second party at all. Both are the kind of thing an
   * account-takeover does first.
   */
  async setRole(adminId: string, role: string, reason: string): Promise<boolean> {
    await this.requireRole("admin", "change admin roles");

    if (!ADMIN_ROLES.includes(role as AdminRole)) {
      throw validationError(`A role must be one of ${ADMIN_ROLES.join(", ")}.`);
    }
    if (adminId === this.admin.id) {
      throw forbidden("You cannot change your own role.");
    }

    const current = await this.db
      .prepare(`SELECT id, role FROM admin_users WHERE id = ?`)
      .bind(adminId)
      .first<{ id: string; role: string }>();
    if (current === null) throw new ApiError("NOT_FOUND", "No such admin account.");

    // Demoting the last super_admin leaves nobody who can promote anyone, and
    // the only way back is the provisioning script.
    if (current.role === "super_admin" && role !== "super_admin") {
      const others = await this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM admin_users
            WHERE role = 'super_admin' AND disabled_at IS NULL AND id != ?`
        )
        .bind(adminId)
        .first<{ n: number }>();
      if ((others?.n ?? 0) === 0) {
        throw new ApiError("CONFLICT", "That is the last super_admin. Promote somebody else first.");
      }
    }

    await this.db.prepare(`UPDATE admin_users SET role = ? WHERE id = ?`).bind(role, adminId).run();

    await this.recordFleet({
      action: "admin.role_change",
      targetType: "admin",
      targetId: adminId,
      reason,
      metadata: { from: current.role, to: role },
    });
    return true;
  }
}
