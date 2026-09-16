/**
 * The workspace routes a signed-in person needs before they have a workspace to
 * be scoped to.
 *
 *   GET    /v1/workspaces       the ones they can reach, for the switcher
 *   POST   /v1/workspaces       create another under their billing account
 *   DELETE /v1/workspaces/:id   destroy one, and everything inside it
 *
 * Both sit outside `withAuth` deliberately, and it is worth being precise about
 * why rather than treating it as an exception. `withAuth` resolves a workspace
 * and binds every repository to it, which is exactly right for every route that
 * acts *inside* one. These act on the set of workspaces itself: one of them
 * exists to create the very thing the other routes need to already have. Making
 * them name a workspace to reach that point would be circular.
 *
 * What they do *not* skip is authentication. The token is verified by the same
 * verifier, the same revocation check runs, and both queries are constrained to
 * organizations this user owns - so neither is a way to see or touch anything
 * outside their own billing account.
 *
 * POST is owner-only by construction rather than by a role check: it writes
 * into the org whose `owner_user_id` is the caller. Somebody invited into one
 * workspace has no owned org, so they get a 403 with nothing to configure.
 */

import { z } from "zod";
import { ApiError, forbidden, validationError } from "../lib/errors";
import { newId } from "../lib/ids";
import { isSlugConflict, uniqueWorkspaceSlug } from "../lib/slug";
import { listWorkspacesForUser } from "../db/user-lookup";
import type { UserRow } from "../db/user-lookup";

/** 30 days, matching the reset the sandbox bootstrap uses. */
const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How many times to re-pick a slug when the unique index rejects one.
 *
 * `uniqueWorkspaceSlug` reads the taken slugs and then writes, so two creates
 * in the same instant can choose the same free name. Only the database can
 * settle that, and it does - the loser sees a UNIQUE violation and simply asks
 * again, by which time the winner's slug is visible to the read. Three attempts
 * is far past the point of plausibility for a single account creating
 * identically-named workspaces simultaneously.
 */
const SLUG_ATTEMPTS = 3;

const createSchema = z.object({
  // Trimmed before the length check by zod's own ordering, so "  A  " is a
  // valid one-character name stored tidy rather than a rejection.
  name: z.string().trim().min(1, "A workspace needs a name.").max(60),
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function listWorkspaces(db: D1Database, user: UserRow): Promise<Response> {
  const workspaces = await listWorkspacesForUser(db, user.id);
  return json({
    workspaces: workspaces.map(workspace => ({
      id: workspace.id,
      name: workspace.name,
      // The dashboard's URL segment. `id` is still here and still the thing
      // every API call takes - the slug is a nicer spelling of the address,
      // not a replacement for the identifier.
      slug: workspace.slug,
      role: workspace.role,
    })),
  });
}

export async function createWorkspaceForUser(
  request: Request,
  db: D1Database,
  user: UserRow,
  now: number
): Promise<Response> {
  let parsed;
  try {
    parsed = createSchema.parse(await request.json());
  } catch (err) {
    throw validationError(
      err instanceof z.ZodError
        ? (err.issues[0]?.message ?? "That workspace name is not valid.")
        : "Send a JSON body with a name."
    );
  }

  const org = await db
    .prepare(`SELECT id FROM organizations WHERE owner_user_id = ?`)
    .bind(user.id)
    .first<{ id: string }>();

  if (org === null) {
    // Someone invited into a workspace, who owns no billing account of their
    // own. Nothing to create against, and nothing they can do about it here.
    throw forbidden("Only an account owner can create a workspace.");
  }

  const workspaceId = newId("workspace", now);

  // This is the only creation path that adds a workspace to an organization
  // that already has some, so it is the only one that has to ask what is taken.
  let slug = "";
  for (let attempt = 1; ; attempt++) {
    slug = await uniqueWorkspaceSlug(db, org.id, parsed.name);
    try {
      await db
        .prepare(
          `INSERT INTO workspaces
             (id, org_id, name, slug, status, period_reset_at, claimed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`
        )
        .bind(workspaceId, org.id, parsed.name, slug, now + PERIOD_MS, now, now, now)
        .run();
      break;
    } catch (err) {
      if (attempt >= SLUG_ATTEMPTS || !isSlugConflict(err)) throw err;
    }
  }

  // No membership row is written. The owner already holds an org-wide one, and
  // adding a per-workspace row beside it would be a second source of truth for
  // the same fact - one that a later "remove from workspace" could delete while
  // leaving them still the owner.
  return json(
    { workspace: { id: workspaceId, name: parsed.name, slug, role: "owner" } },
    201
  );
}

/**
 * The caller has to type the workspace's own name back. The dashboard already
 * asks for it; requiring it at the API too means the confirmation is a property
 * of the operation rather than of one client, so a script, a curl, or a second
 * frontend cannot skip the step that makes this deliberate.
 */
const deleteSchema = z.object({
  name: z.string(),
});

/** R2 accepts up to 1000 keys in one delete. */
const R2_DELETE_CHUNK = 1000;

/**
 * DELETE /v1/workspaces/:id - destroy a workspace and everything in it.
 *
 * The single most destructive thing this API can do, so the gates are stated
 * here rather than spread across the handler:
 *
 *  - **A person, never an API key.** Routed the same way as `logout-all` and for
 *    the same reason: an agent key is issued to manage files inside one
 *    workspace, and a credential that can destroy the workspace it lives in has
 *    quietly acquired authority over the person who issued it. The MCP tool
 *    surface omits workspace management on identical grounds (05 PART 14.4).
 *  - **The account owner, not a workspace admin.** Membership is per workspace;
 *    ownership is of the billing account above it. Someone invited to administer
 *    one workspace must not be able to delete it out from under the account.
 *  - **The name has to be typed back**, as above.
 *  - **Never the last one.** An account with no workspace has nowhere to land -
 *    `RequireWorkspace` renders an explanation aimed at somebody whose invitation
 *    was revoked, which is not this person's situation and offers them nothing.
 *    Refusing is honest and reversible; stranding them is neither.
 *
 * There is no grace period and no soft delete, matching what the dashboard's
 * confirmation has always said out loud ("This cannot be undone"). A workspace
 * kept in a deleted-but-recoverable state would also still be holding its name's
 * UNIQUE slot and its files' bytes, so "deleted" would not mean what a person
 * reading a storage bill assumes it means.
 */
export async function deleteWorkspaceForUser(
  request: Request,
  db: D1Database,
  files: R2Bucket,
  user: UserRow,
  workspaceId: string,
  now: number
): Promise<Response> {
  let parsed;
  try {
    parsed = deleteSchema.parse(await request.json());
  } catch {
    throw validationError(
      "Send a JSON body with the workspace's exact name, to confirm which one you mean."
    );
  }

  // Ownership and existence in one question. Joining through `organizations`
  // rather than `memberships` is the whole authorization check: only the row
  // whose org this user *owns* can match, so an admin of the workspace and a
  // member of another org both fall out as "no such workspace" without a
  // second query that could be got wrong.
  const workspace = await db
    .prepare(
      `SELECT w.id, w.name
         FROM workspaces w
         JOIN organizations o ON o.id = w.org_id
        WHERE w.id = ? AND o.owner_user_id = ?`
    )
    .bind(workspaceId, user.id)
    .first<{ id: string; name: string }>();

  if (workspace === null) {
    // Deliberately not distinguishable from "that workspace does not exist".
    // Telling a non-owner that a workspace is real but not theirs is an oracle
    // for other people's workspace IDs.
    throw new ApiError("NOT_FOUND", "No such workspace.");
  }

  if (parsed.name !== workspace.name) {
    throw validationError("That name doesn't match this workspace.", {
      hint: "Type the workspace's name exactly to confirm.",
    });
  }

  const reachable = await listWorkspacesForUser(db, user.id);
  if (reachable.length <= 1) {
    throw new ApiError("CONFLICT", "This is your only workspace, so it can't be deleted.", {
      details: { hint: "Create another workspace first, then delete this one." },
    });
  }

  // R2 before D1, matching the purge job's ordering and for its reason: the
  // rows are the only record of which objects exist, so losing them first
  // orphans bytes that nothing can ever find again. A failure here leaves the
  // workspace intact and retryable, which is the better half of the trade.
  const objects = await db
    .prepare(`SELECT r2_object_key FROM files WHERE workspace_id = ?`)
    .bind(workspaceId)
    .all<{ r2_object_key: string }>();

  const keys = objects.results.map(row => row.r2_object_key);
  for (let i = 0; i < keys.length; i += R2_DELETE_CHUNK) {
    await files.delete(keys.slice(i, i + R2_DELETE_CHUNK));
  }

  // Every reference INTO the workspace is cleared before anything is removed.
  // Within one statement SQLite deletes rows in an arbitrary order and checks
  // foreign keys immediately, so a self-referencing tree (folders.parent_folder_id)
  // or one referenced from outside it (files.folder_id) fails whichever way the
  // DELETE is written - the same trap `deleteRecursive` documents.
  await db.batch([
    db.prepare(`UPDATE files SET folder_id = NULL WHERE workspace_id = ?`).bind(workspaceId),
    db.prepare(`UPDATE folders SET parent_folder_id = NULL WHERE workspace_id = ?`).bind(workspaceId),
    db
      .prepare(
        `DELETE FROM file_tags
          WHERE file_id IN (SELECT id FROM files WHERE workspace_id = ?)`
      )
      .bind(workspaceId),
    db.prepare(`DELETE FROM files WHERE workspace_id = ?`).bind(workspaceId),
    db.prepare(`DELETE FROM folders WHERE workspace_id = ?`).bind(workspaceId),
    // Keys before agents: api_keys.agent_id points at agents.
    db.prepare(`DELETE FROM api_keys WHERE workspace_id = ?`).bind(workspaceId),
    db.prepare(`DELETE FROM agents WHERE workspace_id = ?`).bind(workspaceId),
    db.prepare(`DELETE FROM webhooks WHERE workspace_id = ?`).bind(workspaceId),
    db.prepare(`DELETE FROM audit_events WHERE workspace_id = ?`).bind(workspaceId),
    // Only the rows naming this workspace. An org-wide membership has a NULL
    // workspace_id and grants the other workspaces on the same bill.
    db.prepare(`DELETE FROM memberships WHERE workspace_id = ?`).bind(workspaceId),
    db.prepare(`DELETE FROM workspaces WHERE id = ?`).bind(workspaceId),
  ]);

  // Logged, not audited, and that is forced rather than chosen: `audit_events`
  // is workspace-scoped by foreign key, so the one row describing a workspace's
  // destruction is the one row it cannot hold. The structured log is where this
  // event survives.
  console.log(
    JSON.stringify({
      level: "warn",
      message: "workspace deleted",
      workspaceId,
      userId: user.id,
      files: keys.length,
      at: new Date(now).toISOString(),
    })
  );

  return json({ id: workspaceId, deleted: true, files: keys.length });
}
