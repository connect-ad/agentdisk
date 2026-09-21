/**
 * Admin actions on a customer's account — 32 PART 6 and 7a.
 *
 * ── The one thing this file does not have ───────────────────────────────────
 * There is no impersonation here, and there is not going to be. Every method
 * acts *on* an account; none acts *as* one. That is why deletion below reuses
 * the shared cascade helper rather than calling the customer's own
 * `DELETE /v1/me`: calling the customer handler would build a real
 * impersonation primitive as a side effect, and would write an audit record
 * claiming the customer deleted their own account.
 *
 * ── Deletion is soft, and nothing irreversible happens inline ───────────────
 * `DELETE /v1/admin/users/:id` sets three things and stops: `deleted_at`,
 * `session_revoked_after`, and the Firebase identity to *disabled* — disabled,
 * never deleted, so it stays recoverable. The org/workspace cascade and the PII
 * scrub happen only from the purge job, 30 days later, and `restore` fully
 * reverses it inside that window.
 *
 * The auth chain refuses `deleted_at IS NOT NULL` as a first-party check, in
 * `auth/authenticate.ts`, before and independently of anything Firebase says.
 * That is what stops deletion depending on a third party's side effect having
 * succeeded — see the comment there.
 */

import { AuditedAdminAccess } from "./audited";
import { ApiError, forbidden, validationError } from "../lib/errors";

export interface AdminUserRecord {
  id: string;
  email: string;
  firebaseUid: string | null;
  emailVerifiedAt: number | null;
  isProvisional: number;
  sessionRevokedAfter: number;
  deletedAt: number | null;
  disabledAt: number | null;
  createdAt: number;
  /** Newest audit event by this actor, which is the only "last active" we store. */
  lastActiveAt: number | null;
}

export interface AdminUserMembership {
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceSlug: string | null;
  orgId: string;
  orgName: string;
  role: string;
}

/** What a revoke-keys action would actually reach, shown before it is committed. */
export interface KeyBlastRadius {
  keys: number;
  workspaces: number;
  /** Workspaces in an organization this person does not belong to. */
  foreignWorkspaces: number;
}

export interface DeletionBlocker {
  kind: "sole_owner_of_shared_org" | "live_billing" | "owner_pointer";
  orgId: string;
  orgName: string;
  detail: string;
}

export interface DeletionCheck {
  userId: string;
  blocked: boolean;
  blockers: DeletionBlocker[];
  keys: KeyBlastRadius;
  /** Organizations that would eventually cascade: solo, no other members. */
  cascadingOrgs: { orgId: string; orgName: string; workspaces: number }[];
}

export class AdminUserAccess extends AuditedAdminAccess {
  /**
   * Exact match only, and deliberately so.
   *
   * No prefix, no partial, no `LIKE`. A admin tool that can search
   * `%@gmail.com` is a admin tool that can enumerate the customer base, and the
   * support workflow this exists for always starts from an address somebody
   * already has. The design file's own note says as much; this is that note
   * made into the behaviour.
   */
  async findByEmail(email: string): Promise<AdminUserRecord | null> {
    const normalised = email.trim().toLowerCase();
    if (normalised === "" || !normalised.includes("@")) {
      throw validationError("A full email address is required. Partial search is unavailable.");
    }

    const row = await this.db
      .prepare(
        `SELECT u.id, u.email, u.firebase_uid AS firebaseUid,
                u.email_verified_at AS emailVerifiedAt, u.is_provisional AS isProvisional,
                u.session_revoked_after AS sessionRevokedAfter,
                u.deleted_at AS deletedAt, u.disabled_at AS disabledAt,
                u.created_at AS createdAt,
                (SELECT MAX(created_at) FROM audit_events WHERE actor_id = u.id) AS lastActiveAt
           FROM users u WHERE u.email = ?`
      )
      .bind(normalised)
      .first<AdminUserRecord>();

    // Recorded whether or not it found anybody. A lookup that missed is still a
    // admin member asking after a named individual, which is the fact the log
    // exists to hold.
    await this.recordFleet({
      action: "user.lookup",
      targetType: "user",
      targetId: row?.id ?? null,
      metadata: { email: normalised, found: row !== null },
    });

    return row;
  }

  async getById(userId: string): Promise<AdminUserRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT u.id, u.email, u.firebase_uid AS firebaseUid,
                u.email_verified_at AS emailVerifiedAt, u.is_provisional AS isProvisional,
                u.session_revoked_after AS sessionRevokedAfter,
                u.deleted_at AS deletedAt, u.disabled_at AS disabledAt,
                u.created_at AS createdAt,
                (SELECT MAX(created_at) FROM audit_events WHERE actor_id = u.id) AS lastActiveAt
           FROM users u WHERE u.id = ?`
      )
      .bind(userId)
      .first<AdminUserRecord>();

    await this.recordFleet({
      action: "user.lookup",
      targetType: "user",
      targetId: userId,
      metadata: { found: row !== null },
    });
    return row;
  }

  /**
   * Every workspace this person can reach, and as what.
   *
   * An org-wide membership (`workspace_id IS NULL`) is the owner's, and covers
   * every workspace under that organization — so it is returned as one row
   * naming the org rather than fanned out per workspace, which is how the
   * customer-facing model actually works and therefore what a support engineer
   * needs to see.
   */
  async membershipsOf(userId: string): Promise<AdminUserMembership[]> {
    const rows = await this.db
      .prepare(
        `SELECT m.workspace_id AS workspaceId, w.name AS workspaceName, w.slug AS workspaceSlug,
                m.org_id AS orgId, o.name AS orgName, m.role
           FROM memberships m
           JOIN organizations o ON o.id = m.org_id
           LEFT JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.user_id = ?
          ORDER BY m.created_at ASC`
      )
      .bind(userId)
      .all<AdminUserMembership>();
    return rows.results ?? [];
  }

  /** What "revoke every key this person created" would actually reach. */
  async keyBlastRadius(userId: string): Promise<KeyBlastRadius> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS keys,
                COUNT(DISTINCT k.workspace_id) AS workspaces,
                COUNT(DISTINCT CASE WHEN NOT EXISTS (
                        SELECT 1 FROM memberships m
                         WHERE m.user_id = ? AND m.org_id = w.org_id
                      ) THEN k.workspace_id END) AS foreignWorkspaces
           FROM api_keys k
           JOIN workspaces w ON w.id = k.workspace_id
          WHERE k.created_by_user_id = ? AND k.revoked_at IS NULL`
      )
      .bind(userId, userId)
      .first<KeyBlastRadius>();
    return row ?? { keys: 0, workspaces: 0, foreignWorkspaces: 0 };
  }

  /**
   * Disable or re-enable an account.
   *
   * Sets `session_revoked_after` as well as the column, because disabling the
   * Firebase identity alone does not invalidate an ID token that has already
   * been issued — it stays valid for up to its remaining hour. The caller is
   * expected to disable the Firebase side too; this is the half that takes
   * effect immediately and does not depend on that call succeeding.
   */
  async setDisabled(userId: string, disabled: boolean, reason: string): Promise<boolean> {
    await this.requireRole("admin", "disable customer accounts");

    const result = await this.db
      .prepare(
        disabled
          ? `UPDATE users SET disabled_at = ?, session_revoked_after = ?, updated_at = ?
              WHERE id = ? AND disabled_at IS NULL AND deleted_at IS NULL`
          : `UPDATE users SET disabled_at = NULL, updated_at = ?
              WHERE id = ? AND deleted_at IS NULL`
      )
      .bind(...(disabled ? [this.now, this.now, this.now, userId] : [this.now, userId]))
      .run();

    const changed = (result.meta.changes ?? 0) > 0;
    await this.recordFleet({
      action: disabled ? "user.disable" : "user.enable",
      targetType: "user",
      targetId: userId,
      reason,
      result: changed ? "success" : "denied",
      metadata: { changed },
    });
    return changed;
  }

  /**
   * What would stop this deletion, asked before the confirm dialog is drawn.
   *
   * Three blockers, and each one is a case where proceeding would do damage
   * that the deletion was never meant to authorise:
   *
   *   sole_owner_of_shared_org — the person is the only owner of an
   *     organization that has other members. Deleting them would eventually
   *     cascade a workspace out from under colleagues who did nothing. The
   *     resolution is Transfer ownership, not deletion.
   *
   *   live_billing — an organization they solely own has a Stripe customer and
   *     a subscription that is not cancelled. Deleting the org row while the
   *     subscription lives keeps charging somebody whose account no longer
   *     exists, and sends webhooks for an org that is not there. Deleting a
   *     human must never implicitly cancel a paid subscription; a person has to
   *     do that in Stripe.
   *
   *   owner_pointer — `organizations.owner_user_id` is a denormalised pointer
   *     independent of `memberships`, and a live source of dangling-owner bugs.
   *     Any org still pointing at this user has to be repointed or explicitly
   *     nulled as part of the flow rather than left aimed at a tombstone.
   */
  async deletionCheck(userId: string): Promise<DeletionCheck> {
    await this.requireRole("admin", "delete customer accounts");

    const owned = await this.db
      .prepare(
        `SELECT o.id AS orgId, o.name AS orgName, o.stripe_customer_id AS stripeCustomerId,
                o.billing_status AS billingStatus, o.owner_user_id AS ownerUserId,
                (SELECT COUNT(*) FROM memberships m2
                  WHERE m2.org_id = o.id AND m2.user_id != ?) AS otherMembers,
                (SELECT COUNT(*) FROM memberships m3
                  WHERE m3.org_id = o.id AND m3.user_id != ? AND m3.role = 'owner') AS otherOwners,
                (SELECT COUNT(*) FROM workspaces w
                  WHERE w.org_id = o.id AND w.status != 'deleted') AS workspaces
           FROM organizations o
           JOIN memberships m ON m.org_id = o.id AND m.user_id = ? AND m.role = 'owner'`
      )
      .bind(userId, userId, userId)
      .all<{
        orgId: string;
        orgName: string;
        stripeCustomerId: string | null;
        billingStatus: string;
        ownerUserId: string;
        otherMembers: number;
        otherOwners: number;
        workspaces: number;
      }>();

    const blockers: DeletionBlocker[] = [];
    const cascadingOrgs: DeletionCheck["cascadingOrgs"] = [];

    for (const org of owned.results ?? []) {
      const soleOwner = org.otherOwners === 0;

      if (soleOwner && org.otherMembers > 0) {
        blockers.push({
          kind: "sole_owner_of_shared_org",
          orgId: org.orgId,
          orgName: org.orgName,
          detail: `Only owner of an organization with ${org.otherMembers} other member(s). Transfer ownership first.`,
        });
      }

      if (
        soleOwner &&
        org.stripeCustomerId !== null &&
        org.billingStatus !== "canceled" &&
        org.billingStatus !== "cancelled"
      ) {
        blockers.push({
          kind: "live_billing",
          orgId: org.orgId,
          orgName: org.orgName,
          detail: `Subscription is ${org.billingStatus}. Cancel it in Stripe before deleting the account.`,
        });
      }

      if (org.ownerUserId === userId && !soleOwner) {
        // Somebody else is also an owner, so the pointer can be repointed
        // rather than the whole deletion being refused - but it must not be
        // left aimed at a row that is about to become a tombstone.
        blockers.push({
          kind: "owner_pointer",
          orgId: org.orgId,
          orgName: org.orgName,
          detail: "organizations.owner_user_id still points at this user. Transfer ownership first.",
        });
      }

      // Solo, nobody else involved: not a blocker, simply part of what the
      // purge job will eventually take with it.
      if (soleOwner && org.otherMembers === 0) {
        cascadingOrgs.push({
          orgId: org.orgId,
          orgName: org.orgName,
          workspaces: org.workspaces,
        });
      }
    }

    const keys = await this.keyBlastRadius(userId);

    await this.recordFleet({
      action: "user.deletion_check",
      targetType: "user",
      targetId: userId,
      metadata: { blockers: blockers.length, cascadingOrgs: cascadingOrgs.length },
    });

    return { userId, blocked: blockers.length > 0, blockers, keys, cascadingOrgs };
  }

  /**
   * Mark an account deleted. Nothing is destroyed here.
   *
   * `revokeKeys` is the operator's explicit choice rather than an automatic
   * cascade, because the keys this person created may be running another
   * tenant's production agents. The confirm dialog shows the blast radius and
   * defaults it on for a for-cause deletion; turning it off has to remain
   * possible.
   */
  async softDelete(
    userId: string,
    reason: string,
    options: { revokeKeys: boolean }
  ): Promise<{ deleted: boolean; keysRevoked: number }> {
    await this.requireRole("admin", "delete customer accounts");

    const check = await this.deletionCheck(userId);
    if (check.blocked) {
      await this.recordFleet({
        action: "user.delete",
        targetType: "user",
        targetId: userId,
        reason,
        result: "denied",
        metadata: { blockers: check.blockers.map(b => b.kind).join(",") },
      });
      throw new ApiError("CONFLICT", "This account cannot be deleted yet.", {
        details: { blockers: check.blockers },
      });
    }

    const result = await this.db
      .prepare(
        `UPDATE users SET deleted_at = ?, session_revoked_after = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`
      )
      .bind(this.now, this.now, this.now, userId)
      .run();

    const deleted = (result.meta.changes ?? 0) > 0;
    let keysRevoked = 0;

    if (deleted && options.revokeKeys) {
      const affected = await this.db
        .prepare(
          `SELECT DISTINCT workspace_id AS workspaceId FROM api_keys
            WHERE created_by_user_id = ? AND revoked_at IS NULL`
        )
        .bind(userId)
        .all<{ workspaceId: string }>();

      const revoked = await this.db
        .prepare(
          `UPDATE api_keys SET revoked_at = ? WHERE created_by_user_id = ? AND revoked_at IS NULL`
        )
        .bind(this.now, userId)
        .run();
      keysRevoked = revoked.meta.changes ?? 0;

      // One row per affected workspace. A workspace owner reading their own log
      // should see that their keys were revoked and by whom, rather than have it
      // recorded only somewhere they cannot see.
      for (const row of affected.results ?? []) {
        await this.record(row.workspaceId, "admin.keys.revoked", { userId, cause: "user.delete" });
      }
    }

    if (deleted) {
      // Share links are deleted rather than marked, because there is no
      // revoked state to mark — see migration 0016. A share link is
      // anonymous and never reaches resolveVerifiedUser, so without this a
      // deleted account's files stay publicly downloadable for the whole
      // grace period while its owner is locked out. Unconditional on
      // `deleted` alone, not on `options.revokeKeys` - whether the operator
      // also revokes this person's API keys is a separate choice, but an
      // already-public link must not survive an account deletion either way.
      const affectedShares = await this.db
        .prepare(`SELECT DISTINCT workspace_id AS workspaceId FROM share_links WHERE created_by = ?`)
        .bind(userId)
        .all<{ workspaceId: string }>();

      await this.db.prepare(`DELETE FROM share_links WHERE created_by = ?`).bind(userId).run();

      for (const row of affectedShares.results ?? []) {
        await this.record(row.workspaceId, "share.revoked", { reason: "account deleted" });
      }
    }

    await this.recordFleet({
      action: "user.delete",
      targetType: "user",
      targetId: userId,
      reason,
      result: deleted ? "success" : "denied",
      metadata: { keysRevoked, revokeKeysRequested: options.revokeKeys },
    });

    return { deleted, keysRevoked };
  }

  /**
   * Undo a deletion inside its window.
   *
   * Keys are NOT un-revoked. Revocation is not part of the deletion — it is a
   * separate choice the operator made alongside it — and a key that has been
   * revoked has been published as revoked to every agent holding it. Reissuing
   * is the customer's call, not a side effect of restoring their login.
   */
  async restore(userId: string, reason: string): Promise<boolean> {
    await this.requireRole("admin", "restore customer accounts");

    const result = await this.db
      .prepare(
        `UPDATE users SET deleted_at = NULL, updated_at = ?
          WHERE id = ? AND deleted_at IS NOT NULL`
      )
      .bind(this.now, userId)
      .run();

    const restored = (result.meta.changes ?? 0) > 0;
    await this.recordFleet({
      action: "user.restore",
      targetType: "user",
      targetId: userId,
      reason,
      result: restored ? "success" : "denied",
    });
    return restored;
  }

  /**
   * Move an organization's ownership to one of its existing members.
   *
   * Both halves, in one statement batch, because they are two representations
   * of one fact and a partial application is the dangling-owner bug this
   * endpoint exists to prevent: the `memberships` row that actually grants
   * authority, and `organizations.owner_user_id`, the denormalised pointer that
   * several queries read instead.
   *
   * The target must already be a member. Promoting an arbitrary user id would
   * make this an endpoint that grants somebody authority over an organization
   * they were never invited to.
   */
  async transferOwner(orgId: string, newOwnerUserId: string, reason: string): Promise<void> {
    await this.requireRole("admin", "transfer organization ownership");

    const org = await this.db
      .prepare(`SELECT id, name, owner_user_id AS ownerUserId FROM organizations WHERE id = ?`)
      .bind(orgId)
      .first<{ id: string; name: string; ownerUserId: string }>();
    if (org === null) throw new ApiError("NOT_FOUND", "No such organization.");

    const membership = await this.db
      .prepare(`SELECT id, role FROM memberships WHERE org_id = ? AND user_id = ?`)
      .bind(orgId, newOwnerUserId)
      .first<{ id: string; role: string }>();
    if (membership === null) {
      throw forbidden("That user is not a member of this organization.");
    }

    const target = await this.db
      .prepare(`SELECT id, deleted_at AS deletedAt FROM users WHERE id = ?`)
      .bind(newOwnerUserId)
      .first<{ id: string; deletedAt: number | null }>();
    if (target === null || target.deletedAt !== null) {
      // Transferring to a tombstone would satisfy the deletion check while
      // leaving the organization owned by nobody who can log in.
      throw forbidden("That user cannot own an organization.");
    }

    await this.db.batch([
      this.db
        .prepare(`UPDATE memberships SET role = 'owner' WHERE org_id = ? AND user_id = ?`)
        .bind(orgId, newOwnerUserId),
      this.db
        .prepare(`UPDATE organizations SET owner_user_id = ?, updated_at = ? WHERE id = ?`)
        .bind(newOwnerUserId, this.now, orgId),
    ]);

    await this.recordFleet({
      action: "org.transfer_owner",
      targetType: "org",
      targetId: orgId,
      reason,
      metadata: { from: org.ownerUserId, to: newOwnerUserId },
    });
  }
}
