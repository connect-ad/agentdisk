/**
 * Staff accounts, managed from the console — 32 PART 6 (Staff accounts).
 *
 * ── This softens an existing "never", deliberately and narrowly ─────────────
 * `CLAUDE.md` records the rule: *the first staff account cannot come from the
 * API, and that is the design*, because an endpoint that mints a working staff
 * credential is an endpoint that can be tricked into minting one. That rule is
 * about BOOTSTRAP, and the reasoning is specific — at bootstrap there is no
 * staff credential in existence to gate the endpoint on, so any such endpoint
 * is reachable by whoever can reach the API.
 *
 * `POST /v1/staff/users` therefore still returns 501 and is left exactly as it
 * was. This is a different endpoint with a different precondition: it requires
 * an authenticated super_admin, so it cannot bootstrap anything — it can only
 * be used by somebody who already holds the highest credential in the system,
 * and every use writes an audit row naming who created whom. The first account
 * still comes from `scripts/provision-staff.mjs`.
 *
 * ── Pending enrolment, and why a pending account can still log in ──────────
 * 32 PART 4 asks for a pending account to be "unable to authenticate at all
 * until enrolment completes". Read literally that produces an account that can
 * never be used: enrolment here is scanning a QR, there is no separate confirm
 * step, and the only way to prove the code was scanned is to present a valid
 * one. So `totp_confirmed_at` is set by the first successful login, and pending
 * means *created but never signed in*. The distinction PART 4 actually wants —
 * pending-enrolment versus enrolled-without-TOTP — is preserved, because the
 * second state remains impossible: TOTP is mandatory at login for every row.
 *
 * ── Never deleted, only disabled ───────────────────────────────────────────
 * There is no delete method here and there should not be one. The audit log has
 * to keep resolving a historical actor, and `staff_actions` deliberately has no
 * foreign key to this table so that a log row survives whatever happens to the
 * account — but a disabled row is what keeps the *email and role at the time*
 * meaningful when somebody reads the log a year later.
 */

import { AuditedStaffAccess } from "./audited";
import { ApiError, forbidden, validationError } from "../lib/errors";
import { newId } from "../lib/ids";
import {
  encryptSecret,
  generateTotpSecret,
  hashPassword,
  totpProvisioningUri,
} from "./crypto";
import { STAFF_ROLES, type StaffRole } from "./access";

export interface StaffAccountRow {
  id: string;
  email: string;
  role: string;
  disabledAt: number | null;
  lastLoginAt: number | null;
  totpConfirmedAt: number | null;
  createdAt: number;
}

/** Shown exactly once, like an API key or a webhook secret. Never stored. */
export interface StaffAccountSecret {
  password: string;
  totpSecret: string;
  provisioningUri: string;
}

/**
 * A password generated rather than chosen.
 *
 * Same reasoning as the provisioning script: a staff password typed by a human
 * at creation time is a password that gets reused, and this is the credential
 * with cross-tenant reach. 30 characters from a 32-symbol alphabet is ~150
 * bits, which is far past anything PBKDF2's iteration count needs to defend.
 */
function generatePassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(30));
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
}

export class StaffAccountAccess extends AuditedStaffAccess {
  async list(): Promise<StaffAccountRow[]> {
    await this.requireRole("super_admin", "manage staff accounts");

    const rows = await this.db
      .prepare(
        `SELECT id, email, role, disabled_at AS disabledAt, last_login_at AS lastLoginAt,
                totp_confirmed_at AS totpConfirmedAt, created_at AS createdAt
           FROM staff_users ORDER BY created_at ASC`
      )
      .all<StaffAccountRow>();

    await this.recordFleet({ action: "staff.list", metadata: { count: rows.results?.length ?? 0 } });
    return rows.results ?? [];
  }

  /**
   * Create a staff account, returning its credential once.
   *
   * The password and the TOTP secret are returned in this response and written
   * nowhere else: the row holds a PBKDF2 hash and an AES-GCM ciphertext, and
   * neither is usable on its own. If the caller loses this response the account
   * has to be recreated, which is the same contract the customer-facing API key
   * flow has.
   */
  async create(
    email: string,
    role: string,
    encryptionKey: string | undefined,
    reason: string
  ): Promise<{ account: StaffAccountRow; secret: StaffAccountSecret }> {
    await this.requireRole("super_admin", "create staff accounts");

    const normalised = email.trim().toLowerCase();
    if (normalised === "" || !normalised.includes("@")) {
      throw validationError("A staff email address is required.");
    }
    if (!STAFF_ROLES.includes(role as StaffRole)) {
      throw validationError(`A role must be one of ${STAFF_ROLES.join(", ")}.`);
    }
    if (encryptionKey === undefined || encryptionKey === "") {
      // Without it the TOTP secret would have to be stored in plaintext, which
      // makes the second factor worth exactly as much as the database it sits
      // in. Refusing is the only correct answer.
      throw new ApiError("INTERNAL_ERROR", "Staff provisioning is not configured here.", {
        internalReason: "DATABASE_ENCRYPTION_KEY is not set",
      });
    }

    const existing = await this.db
      .prepare(`SELECT id FROM staff_users WHERE email = ?`)
      .bind(normalised)
      .first<{ id: string }>();
    if (existing !== null) {
      throw new ApiError("CONFLICT", "A staff account already exists for that address.");
    }

    const id = newId("staffUser", this.now);
    const password = generatePassword();
    const totpSecret = generateTotpSecret();

    await this.db
      .prepare(
        `INSERT INTO staff_users
           (id, email, password_hash, totp_secret, role, disabled_at, last_login_at,
            created_at, totp_confirmed_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL)`
      )
      .bind(
        id,
        normalised,
        await hashPassword(password),
        await encryptSecret(totpSecret, encryptionKey),
        role,
        this.now
      )
      .run();

    await this.recordFleet({
      action: "staff.create",
      targetType: "staff",
      targetId: id,
      reason,
      // The credential is never in the metadata. What is worth recording is who
      // was granted what.
      metadata: { email: normalised, role },
    });

    return {
      account: {
        id,
        email: normalised,
        role,
        disabledAt: null,
        lastLoginAt: null,
        totpConfirmedAt: null,
        createdAt: this.now,
      },
      secret: {
        password,
        totpSecret,
        provisioningUri: totpProvisioningUri(normalised, totpSecret),
      },
    };
  }

  /**
   * Disable or re-enable an account.
   *
   * Disabling also revokes every live session for it. Without that, a disabled
   * staff member keeps their cross-tenant reach for up to the remaining four
   * hours of a session that was already open — which is the entire window in
   * which somebody being removed for cause would use it.
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

    if (changed && disabled) {
      await this.db
        .prepare(
          `UPDATE staff_sessions SET revoked_at = ?
            WHERE staff_user_id = ? AND revoked_at IS NULL`
        )
        .bind(this.now, staffId)
        .run();
    }

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
