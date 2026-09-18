/**
 * Staff accounts — 32 PART 6, as amended by migration 0014.
 *
 * ── An account is an email address and a role ──────────────────────────────
 * There is no credential to mint any more. Staff sign in through Firebase like
 * everybody else, so adding an administrator is adding a row here, and that row
 * is the only thing that separates a staff member from any other signed-in
 * customer. Nothing is shown once, because nothing secret is created.
 *
 * That also dissolves the rule `CLAUDE.md` recorded - *the first staff account
 * cannot come from the API* - rather than softening it. The rule existed
 * because an endpoint that mints a working staff credential can be tricked into
 * minting one. This endpoint mints nothing: it grants an existing, independently
 * authenticated identity a role. The first row is seeded by the migration,
 * which is the only place it could come from now.
 *
 * ── Never deleted, only disabled ───────────────────────────────────────────
 * Unchanged, and for the unchanged reason: the audit log has to keep resolving
 * a historical actor, and `staff_actions` denormalises the email and role *at
 * the time* precisely so a later edit here cannot rewrite what somebody did.
 */

import { AuditedStaffAccess } from "./audited";
import { ApiError, forbidden, validationError } from "../lib/errors";
import { newId } from "../lib/ids";
import { STAFF_ROLES, type StaffRole } from "./access";

export interface StaffAccountRow {
  id: string;
  email: string;
  role: string;
  disabledAt: number | null;
  /** Set by requireStaff on every authenticated request, not by a login route. */
  lastLoginAt: number | null;
  createdAt: number;
  invitedBy: string | null;
}

export class StaffAccountAccess extends AuditedStaffAccess {
  async list(): Promise<StaffAccountRow[]> {
    await this.requireRole("super_admin", "manage staff accounts");

    const rows = await this.db
      .prepare(
        `SELECT id, email, role, disabled_at AS disabledAt, last_login_at AS lastLoginAt,
                created_at AS createdAt, invited_by AS invitedBy
           FROM staff_users ORDER BY created_at ASC`
      )
      .all<StaffAccountRow>();

    await this.recordFleet({ action: "staff.list", metadata: { count: rows.results?.length ?? 0 } });
    return rows.results ?? [];
  }

  /**
   * Grant an email address a staff role.
   *
   * Whoever holds that address at this Firebase project becomes staff the next
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
  ): Promise<StaffAccountRow> {
    await this.requireRole("super_admin", "create staff accounts");

    const normalised = email.trim().toLowerCase();
    if (normalised === "" || !normalised.includes("@")) {
      throw validationError("A staff email address is required.");
    }
    if (!STAFF_ROLES.includes(role as StaffRole)) {
      throw validationError(`A role must be one of ${STAFF_ROLES.join(", ")}.`);
    }

    const existing = await this.db
      .prepare(`SELECT id FROM staff_users WHERE email = ?`)
      .bind(normalised)
      .first<{ id: string }>();
    if (existing !== null) {
      throw new ApiError("CONFLICT", "That address already has a staff role.");
    }

    const id = newId("staffUser", this.now);
    await this.db
      .prepare(
        `INSERT INTO staff_users
           (id, email, role, disabled_at, last_login_at, created_at, invited_by)
         VALUES (?, ?, ?, NULL, NULL, ?, ?)`
      )
      .bind(id, normalised, role, this.now, this.staff.id)
      .run();

    await this.recordFleet({
      action: "staff.create",
      targetType: "staff",
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
      invitedBy: this.staff.id,
    };
  }

  /**
   * Disable or re-enable an account.
   *
   * Takes effect on their very next request. `requireStaff` reads this column
   * on every call, so there is no window at all — which is strictly better than
   * the four-hour session this replaced, where a disable could not reach a
   * session already open.
   */
  async setDisabled(staffId: string, disabled: boolean, reason: string): Promise<boolean> {
    await this.requireRole("super_admin", "disable staff accounts");

    if (staffId === this.staff.id && disabled) {
      // Disabling yourself removes the only role that can re-enable anyone, and
      // there may be no other super_admin. The recovery path would be the
      // provisioning script and a database write.
      throw forbidden("You cannot disable your own staff account.");
    }

    const result = await this.db
      .prepare(
        disabled
          ? `UPDATE staff_users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`
          : `UPDATE staff_users SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL`
      )
      .bind(...(disabled ? [this.now, staffId] : [staffId]))
      .run();

    const changed = (result.meta.changes ?? 0) > 0;

    await this.recordFleet({
      action: disabled ? "staff.disable" : "staff.enable",
      targetType: "staff",
      targetId: staffId,
      reason,
      result: changed ? "success" : "denied",
    });
    return changed;
  }

  /**
   * Change a staff member's role.
   *
   * Refuses to change your own, in either direction. Demoting yourself can
   * strip the last super_admin; promoting yourself is a privilege escalation
   * that would need no second party at all. Both are the kind of thing an
   * account-takeover does first.
   */
  async setRole(staffId: string, role: string, reason: string): Promise<boolean> {
    await this.requireRole("super_admin", "change staff roles");

    if (!STAFF_ROLES.includes(role as StaffRole)) {
      throw validationError(`A role must be one of ${STAFF_ROLES.join(", ")}.`);
    }
    if (staffId === this.staff.id) {
      throw forbidden("You cannot change your own role.");
    }

    const current = await this.db
      .prepare(`SELECT id, role FROM staff_users WHERE id = ?`)
      .bind(staffId)
      .first<{ id: string; role: string }>();
    if (current === null) throw new ApiError("NOT_FOUND", "No such staff account.");

    // Demoting the last super_admin leaves nobody who can promote anyone, and
    // the only way back is the provisioning script.
    if (current.role === "super_admin" && role !== "super_admin") {
      const others = await this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM staff_users
            WHERE role = 'super_admin' AND disabled_at IS NULL AND id != ?`
        )
        .bind(staffId)
        .first<{ n: number }>();
      if ((others?.n ?? 0) === 0) {
        throw new ApiError("CONFLICT", "That is the last super_admin. Promote somebody else first.");
      }
    }

    await this.db.prepare(`UPDATE staff_users SET role = ? WHERE id = ?`).bind(role, staffId).run();

    await this.recordFleet({
      action: "staff.role_change",
      targetType: "staff",
      targetId: staffId,
      reason,
      metadata: { from: current.role, to: role },
    });
    return true;
  }
}
