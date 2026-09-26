/**
 * The workspace routes a signed-in person needs before they have a workspace to
 * be scoped to.
 *
 *   GET    /v1/workspaces       the ones they can reach, for the switcher
 *   POST   /v1/workspaces       create another under their billing account
 *   DELETE /v1/workspaces/:id   destroy one, and everything inside it
 *   PATCH  /v1/workspaces/:id   rename one
 *
 * PATCH is the exception to everything the next paragraph says, and the reason
 * is worth stating. The other three act on the *set* of workspaces, so making
 * them name one would be circular. A rename acts inside a workspace that
 * already exists and is already named in the URL - so it goes through `withAuth`
 * like every ordinary route, which is what gives it a membership check, a role,
 * and an `audit()` that a deletion cannot have (see `deleteWorkspaceForUser`:
 * `audit_events` is workspace-scoped by foreign key, so the row describing a
 * workspace's destruction is the one row it cannot hold - a rename leaves the
 * workspace standing, so its own record survives with it).
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
import { assertCanAdminister, isMemberRole } from "../auth/roles";
import { audit } from "../lib/audit";
import type { AuthContext } from "../middleware/auth";
import { newId } from "../lib/ids";
import { isSlugConflict, uniqueWorkspaceSlug } from "../lib/slug";
import { listWorkspacesForUser } from "../db/user-lookup";
import { deleteWorkspaceCascade } from "../db/workspace-cascade";
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
      `SELECT w.id, w.name, w.org_id
         FROM workspaces w
         JOIN organizations o ON o.id = w.org_id
        WHERE w.id = ? AND o.owner_user_id = ?`
    )
    .bind(workspaceId, user.id)
    .first<{ id: string; name: string; org_id: string }>();

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

  // The ordering, the R2-before-D1 rule and the FK dance all live in
  // deleteWorkspaceCascade now, shared with the claim merge's cleanup and the
  // unclaimed sweep. The gates above are what make *this* caller a person's
  // deliberate act; the cascade itself is the same operation in all three.
  // Deferred: the workspace, its keys, its agents, its webhooks and its share
  // links are destroyed here and now, and only the bytes wait. That is not a
  // softening of the promise - every surface a person or an agent could reach
  // is gone when this returns. What defers is the part nobody can observe, and
  // deferring it is what makes this request bounded, atomic and reversible-by-
  // hand for seven days instead of unbounded, half-atomic and final.
  const { objectsDeferred } = await deleteWorkspaceCascade(db, files, workspaceId, {
    workspaceName: workspace.name,
    orgId: workspace.org_id,
    deletedBy: user.id,
    now,
  });

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
      // What was queued, not what was destroyed - the objects are still there
      // for seven days and saying "deleted" here would be the log lying about
      // the one fact this change exists to create.
      filesQueued: objectsDeferred,
      at: new Date(now).toISOString(),
    })
  );

  return json({ id: workspaceId, deleted: true, files: objectsDeferred });
}

const renameSchema = z.object({
  // Same shape as creation, so a name that could be created can be set.
  name: z.string().trim().min(1, "A workspace needs a name.").max(60),
});

/**
 * PATCH /v1/workspaces/:id - rename, and nothing else.
 *
 * Owner or admin, via `assertCanAdminister`, whose own comment already scopes it
 * as "workspace settings short of deletion". A reader is refused: they can see
 * the workspace, not re-label it for everybody else in it.
 *
 * Refused for an API key. An agent's credential renaming the workspace would
 * change what every person in the dashboard sees, driven by something with no
 * person behind it - the same reasoning that keeps an API key away from the
 * member roster.
 *
 * The name is the only field. A slug is not derivable from it here and must not
 * be: see `WorkspaceScopedSettings.rename`.
 */
export async function renameWorkspace(
  ctx: AuthContext,
  request: Request,
  workspaceId: string
): Promise<Response> {
  // `withAuth` resolved the credential against ?workspaceId=; the URL names the
  // subject. A mismatch is refused rather than silently preferring one, because
  // a caller that believes it is renaming a different workspace must be told it
  // is not - the same rule withAuth applies to an API key that names one.
  if (workspaceId !== ctx.workspaceId) {
    throw forbidden("The workspace named in the path is not the one this request is scoped to.");
  }

  if (ctx.identity.kind !== "firebase_user") {
    throw forbidden("Only a signed-in user can rename a workspace.");
  }
  if (!isMemberRole(ctx.identity.role)) throw forbidden("Unknown role.");
  assertCanAdminister(ctx.identity.role);

  let parsed;
  try {
    parsed = renameSchema.parse(await request.json());
  } catch {
    throw validationError("Send a JSON body with the workspace's new name.");
  }

  const previous = ctx.workspace.name;
  if (parsed.name === previous) {
    // Nothing to write, and nothing worth an audit row either.
    return json({ workspace: { id: workspaceId, name: previous, slug: ctx.workspace.slug } });
  }

  await ctx.db.settings.rename(parsed.name, ctx.now);

  audit(ctx, request, "workspace.renamed", {
    resourceType: "workspace",
    resourceId: workspaceId,
    metadata: { from: previous, to: parsed.name },
  });

  return json({ workspace: { id: workspaceId, name: parsed.name, slug: ctx.workspace.slug } });
}
