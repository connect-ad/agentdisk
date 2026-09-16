/**
 * Resolving a verified Firebase token to an AgentDisk user, and provisioning
 * one the first time we see a `firebase_uid` (16 PART 30.3).
 *
 * These are the only queries in the codebase that touch `users` outside a
 * workspace scope, which is correct: identity is resolved *before* a workspace
 * is known, and is the one thing that cannot itself be workspace-scoped.
 */

import { newId } from "../lib/ids";
import { slugify } from "../lib/slug";

import type { FirebaseClaims } from "../auth/firebase";

/**
 * Renameable, and named so it reads as a starting point rather than a label
 * somebody chose. The alternative - deriving it from the person's name - reads
 * oddly the moment they invite a colleague into "Karim's Workspace".
 */
const DEFAULT_WORKSPACE_NAME = "My Workspace";

/** Usage counters reset monthly; the first period starts now. */
function periodResetAt(now: number): number {
  return now + 30 * 24 * 60 * 60 * 1000;
}

export interface UserRow {
  id: string;
  email: string;
  firebase_uid: string | null;
  is_provisional: number;
  email_verified_at: number | null;
  /** Unix ms. Tokens issued at or before this are refused (30.4). */
  session_revoked_after: number;
}

export interface MembershipRow {
  org_id: string;
  role: string;
}

export async function findUserByFirebaseUid(
  db: D1Database,
  firebaseUid: string
): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT id, email, firebase_uid, is_provisional, email_verified_at, session_revoked_after
         FROM users WHERE firebase_uid = ?`
    )
    .bind(firebaseUid)
    .first<UserRow>();
}

/**
 * Attach a Firebase account to a `users` row that already exists for that email.
 *
 * This is what makes an invitation work: a colleague is added to an org by
 * email before they have ever signed in, so the row predates the Firebase
 * account. Guarded on `firebase_uid IS NULL` so it can only ever claim an
 * unclaimed row - if two accounts race for one email, the second gets zero rows
 * changed and provisions its own, rather than silently taking over the first.
 */
export async function linkFirebaseUidToEmail(
  db: D1Database,
  email: string,
  firebaseUid: string,
  now: number
): Promise<UserRow | null> {
  const result = await db
    .prepare(
      `UPDATE users SET firebase_uid = ?, is_provisional = 0, updated_at = ?
        WHERE email = ? AND firebase_uid IS NULL`
    )
    .bind(firebaseUid, now, email)
    .run();

  if (result.meta.changes === 0) return null;
  return findUserByFirebaseUid(db, firebaseUid);
}

/**
 * The address to store, which is not always the one on the token.
 *
 * `users.email` is NOT NULL UNIQUE, so an address that somebody already holds
 * cannot be written at all - discovering that by crashing on the unique
 * constraint would turn a foreseeable signup into a 500 whose failure mode also
 * confirms the address is registered. A taken address therefore falls back to a
 * placeholder on the RFC 2606 `.invalid` TLD, which can never resolve or
 * receive mail.
 *
 * **An *unverified* address is stored, and that is a deliberate correction.**
 * The first version of this refused those too, reasoning that anyone could type
 * a colleague's address into a signup form. That reasoning was right about the
 * danger and wrong about where it lives: this row is brand new, collides with
 * nothing, and grants nothing - so writing the address here takes nothing from
 * anybody. Refusing it instead made every email/password signup display as
 * `<uid>@firebase.invalid` until they clicked a link, and made them impossible
 * to invite by the address they actually gave.
 *
 * The danger is real but belongs one step later: an unverified squatter must
 * not be able to *receive an invitation* meant for the real owner of that
 * address. That check lives at the invite (routes/members.ts), where the
 * verified state is what is actually being relied upon.
 */
async function usableEmail(db: D1Database, claims: FirebaseClaims): Promise<string> {
  const placeholder = `${claims.uid}@firebase.invalid`;
  if (claims.email === null) return placeholder;

  const taken = await db
    .prepare(`SELECT 1 AS present FROM users WHERE email = ?`)
    .bind(claims.email)
    .first<{ present: number }>();

  return taken === null ? claims.email : placeholder;
}

/**
 * Adopt the real address once Firebase has verified it.
 *
 * Two rows need this. One provisioned before the address was free, and one
 * provisioned from a token with no email at all. Without it, a placeholder is
 * permanent - the row would keep working and keep displaying as
 * `<uid>@firebase.invalid` forever, which is exactly the state this function
 * exists to get out of.
 *
 * Guarded on the address still being free, so this can never take an address
 * from the row that legitimately holds it.
 */
export async function adoptVerifiedEmail(
  db: D1Database,
  user: UserRow,
  claims: FirebaseClaims,
  now: number
): Promise<UserRow> {
  const wantsAdoption =
    claims.email !== null && claims.emailVerified && user.email !== claims.email;
  if (!wantsAdoption) {
    // Still record that the address was verified, even when it is unchanged.
    if (claims.emailVerified && user.email_verified_at === null) {
      await db
        .prepare(`UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?`)
        .bind(now, now, user.id)
        .run();
      return { ...user, email_verified_at: now };
    }
    return user;
  }

  const taken = await db
    .prepare(`SELECT 1 AS present FROM users WHERE email = ? AND id != ?`)
    .bind(claims.email, user.id)
    .first<{ present: number }>();
  if (taken !== null) return user;

  await db
    .prepare(`UPDATE users SET email = ?, email_verified_at = ?, updated_at = ? WHERE id = ?`)
    .bind(claims.email, now, now, user.id)
    .run();
  return { ...user, email: claims.email as string, email_verified_at: now };
}

/**
 * First sight of a Firebase account: create the user, and the organization and
 * membership that make them an owner of something.
 *
 * One batch, so a half-provisioned identity cannot exist - the same reasoning
 * as the sandbox bootstrap. A user row without a membership would authenticate
 * successfully and then be unable to reach anything at all, which is a worse
 * failure than not authenticating in the first place.
 *
 * A default workspace is created too. Signing up and landing on an empty screen
 * that asks you to create a container before you can do the thing you came for
 * is a worse first minute than one named workspace you can rename later - and
 * "upload a file" has to work immediately for the product to make its point.
 */
export async function provisionUser(
  db: D1Database,
  claims: FirebaseClaims,
  now: number
): Promise<UserRow> {
  const userId = newId("user", now);
  const orgId = newId("organization", now);
  const membershipId = newId("membership", now);
  const workspaceId = newId("workspace", now);

  const email = await usableEmail(db, claims);
  const orgName = claims.displayName ?? email.split("@")[0] ?? "Personal";

  await db.batch([
    db
      .prepare(
        `INSERT INTO users
           (id, email, firebase_uid, email_verified_at, is_provisional,
            session_revoked_after, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, ?, ?)`
      )
      .bind(userId, email, claims.uid, claims.emailVerified ? now : null, now, now),

    db
      .prepare(
        `INSERT INTO organizations (id, name, owner_user_id, plan, created_at, updated_at)
         VALUES (?, ?, ?, 'free', ?, ?)`
      )
      .bind(orgId, orgName, userId, now, now),

    // workspace_id NULL: owning the billing account means owning every
    // workspace under it, now and later, without a row per workspace that
    // something has to remember to create.
    db
      .prepare(
        `INSERT INTO memberships (id, org_id, user_id, workspace_id, role, created_at)
         VALUES (?, ?, ?, NULL, 'owner', ?)`
      )
      .bind(membershipId, orgId, userId, now),

    db
      .prepare(
        `INSERT INTO workspaces
           (id, org_id, name, slug, status, period_reset_at, claimed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      // No uniqueness query: the organization on the line above is brand new,
      // so this is the only workspace in it and nothing can be collided with.
      .bind(
        workspaceId,
        orgId,
        DEFAULT_WORKSPACE_NAME,
        slugify(DEFAULT_WORKSPACE_NAME),
        periodResetAt(now),
        now,
        now,
        now
      ),
  ]);

  return {
    id: userId,
    email,
    firebase_uid: claims.uid,
    is_provisional: 0,
    email_verified_at: claims.emailVerified ? now : null,
    session_revoked_after: 0,
  };
}

/**
 * Whether this user may act in this workspace, and as what.
 *
 * Two ways to hold access, and the query has to consider both:
 *   - an org-wide row (`workspace_id IS NULL`), which is what the owner of the
 *     billing account holds, covering every workspace under it;
 *   - a row naming this one workspace, which is what an invited admin or
 *     reader holds.
 *
 * Ordered so the org-wide row wins when somebody has both. That can happen if
 * an owner is also explicitly invited to one of their own workspaces as a
 * reader - and being demoted inside something you own and pay for would be
 * surprising in exactly the wrong direction.
 */
export async function findMembershipForWorkspace(
  db: D1Database,
  userId: string,
  workspaceId: string
): Promise<MembershipRow | null> {
  return db
    .prepare(
      `SELECT m.org_id, m.role
         FROM memberships m
         JOIN workspaces w ON w.org_id = m.org_id
        WHERE m.user_id = ?
          AND w.id = ?
          AND (m.workspace_id IS NULL OR m.workspace_id = w.id)
        ORDER BY m.workspace_id IS NULL DESC
        LIMIT 1`
    )
    .bind(userId, workspaceId)
    .first<MembershipRow>();
}

/** The workspaces this user can reach, for the dashboard's workspace switcher. */
export async function listWorkspacesForUser(
  db: D1Database,
  userId: string
): Promise<{ id: string; name: string; slug: string | null; role: string; status: string }[]> {
  const rows = await db
    .prepare(
      `SELECT w.id, w.name, w.slug, w.status, m.role
         FROM workspaces w
         JOIN memberships m ON m.org_id = w.org_id
        WHERE m.user_id = ?
          AND (m.workspace_id IS NULL OR m.workspace_id = w.id)
          AND w.status = 'active'
        GROUP BY w.id
        ORDER BY w.created_at ASC`
    )
    .bind(userId)
    .all<{ id: string; name: string; slug: string | null; role: string; status: string }>();
  return rows.results;
}

/**
 * "Log out everywhere" (30.4): every ID token issued before now stops working.
 *
 * The Firebase SDK holds a refresh token we never see, so the practical effect
 * is that every other open session quietly mints a fresh token and continues -
 * which is the right answer for "I left myself signed in somewhere", and
 * explicitly not a substitute for revoking a stolen device's refresh token.
 */
export async function revokeSessionsBefore(
  db: D1Database,
  userId: string,
  now: number
): Promise<void> {
  await db
    .prepare(`UPDATE users SET session_revoked_after = ?, updated_at = ? WHERE id = ?`)
    .bind(now, now, userId)
    .run();
}
