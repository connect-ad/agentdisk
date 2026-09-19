/**
 * Who can act in a workspace, and how that changes.
 *
 * Membership is deliberately not workspace-scoped in the `WorkspaceScoped`
 * sense, because it spans two things at once: a row either grants one workspace
 * or grants every workspace in the billing account. Every query here therefore
 * takes the workspace explicitly and resolves the org from it, rather than
 * being handed a pre-bound scope — the alternative is a repository whose
 * constructor cannot express the org-wide case at all.
 *
 * The one invariant worth stating out loud: **an org-wide row is never
 * editable through this class.** That row is the account owner, and letting a
 * workspace-level screen demote or remove it would let somebody lock the paying
 * customer out of the thing they pay for.
 *
 * The workspace is bound in the constructor and never passed as an argument,
 * for the same reason every other repository here does it: a handler then has
 * no argument through which to name somebody else's workspace.
 */

import { newId } from "../lib/ids";

export interface MemberRecord {
  membershipId: string;
  userId: string;
  email: string;
  role: string;
  /** Null for the account owner, whose row grants every workspace. */
  workspaceId: string | null;
  createdAt: number;
}

export class WorkspaceMembers {
  constructor(
    private readonly db: D1Database,
    private readonly workspaceId: string
  ) {}

  /**
   * Everyone who can reach this workspace: the account owner, plus anybody
   * invited to this workspace specifically.
   */
  async list(): Promise<MemberRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT m.id AS membershipId, m.user_id AS userId, m.role, m.workspace_id AS workspaceId,
                m.created_at AS createdAt, u.email
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           JOIN workspaces w ON w.org_id = m.org_id
          WHERE w.id = ?
            AND (m.workspace_id IS NULL OR m.workspace_id = w.id)
          ORDER BY m.workspace_id IS NULL DESC, m.created_at ASC`
      )
      .bind(this.workspaceId)
      .all<MemberRecord>();
    return result.results ?? [];
  }

  /** Users are not workspace-scoped; an invitation has to look outside. */
  async findUserByEmail(email: string): Promise<{
    id: string;
    email: string;
    firebase_uid: string | null;
    emailVerifiedAt: number | null;
  } | null> {
    return this.db
      .prepare(
        `SELECT id, email, firebase_uid, email_verified_at AS emailVerifiedAt
           FROM users WHERE email = ?`
      )
      .bind(email)
      .first<{
        id: string;
        email: string;
        firebase_uid: string | null;
        emailVerifiedAt: number | null;
      }>();
  }

  async find(membershipId: string): Promise<MemberRecord | null> {
    return this.db
      .prepare(
        `SELECT m.id AS membershipId, m.user_id AS userId, m.role, m.workspace_id AS workspaceId,
                m.created_at AS createdAt, u.email
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           JOIN workspaces w ON w.org_id = m.org_id
          WHERE m.id = ? AND w.id = ?
            AND (m.workspace_id IS NULL OR m.workspace_id = w.id)`
      )
      .bind(membershipId, this.workspaceId)
      .first<MemberRecord>();
  }

  /** Add somebody to this one workspace. Never org-wide — that row is the owner's. */
  async add(userId: string, role: string, now: number): Promise<MemberRecord | null> {
    const workspace = await this.db
      .prepare(`SELECT org_id FROM workspaces WHERE id = ?`)
      .bind(this.workspaceId)
      .first<{ org_id: string }>();
    if (workspace === null) return null;

    const membershipId = newId("membership", now);
    await this.db
      .prepare(
        `INSERT INTO memberships (id, org_id, user_id, workspace_id, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(membershipId, workspace.org_id, userId, this.workspaceId, role, now)
      .run();

    return this.find(membershipId);
  }

  /**
   * Change an invited person's role.
   *
   * Guarded on `workspace_id = ?` rather than just the membership id, so the
   * statement itself cannot touch the org-wide owner row even if a caller
   * found its id somehow.
   */
  async setRole(membershipId: string, role: string): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE memberships SET role = ? WHERE id = ? AND workspace_id = ?`)
      .bind(role, membershipId, this.workspaceId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async remove(membershipId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM memberships WHERE id = ? AND workspace_id = ?`)
      .bind(membershipId, this.workspaceId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * Revoke every live key one person created in one workspace.
   *
   * Deliberately not automatic when they are removed. A departing colleague's
   * session dies the moment their membership does, but a key they minted may
   * be running production traffic — 06 PART 15.3 is explicit that keys are
   * workspace assets rather than personal property, so severing them is a
   * choice somebody makes with their eyes open, defaulted to on in the UI
   * (03 §8.22) and never silently implied by "remove".
   */
  async revokeKeysCreatedBy(userId: string, now: number): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE api_keys SET revoked_at = ?
          WHERE workspace_id = ? AND created_by_user_id = ? AND revoked_at IS NULL`
      )
      .bind(now, this.workspaceId, userId)
      .run();
    return result.meta.changes ?? 0;
  }
}
