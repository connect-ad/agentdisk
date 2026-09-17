/**
 * Destroying one workspace and everything under it.
 *
 * Extracted from `deleteWorkspaceForUser` because three callers now need the
 * same ordering and none of them may diverge from it:
 *
 *   1. A person deleting their own workspace (routes/workspaces.ts).
 *   2. Cleaning up a sandbox whose contents were just merged elsewhere
 *      (routes/claim.ts, mode "attach").
 *   3. The unclaimed sweep reclaiming an abandoned sandbox
 *      (jobs/sandbox-expiry.ts).
 *
 * Callers 2 and 3 deliberately do **not** go through `deleteWorkspaceForUser`,
 * even though it would delete the same rows. That function requires the
 * workspace's name typed back in a request body, and refuses to delete somebody's
 * last workspace - two confirmations that exist to protect a person from
 * destroying their own data by accident. Neither means anything for a
 * system-initiated cleanup of a workspace that is already empty or already
 * expired, and routing a cron job through a function that demands a typed
 * confirmation would mean either faking the confirmation or weakening it.
 *
 * **The FK ordering is the load-bearing part.** Within one statement SQLite
 * deletes rows in an arbitrary order and checks foreign keys immediately, so a
 * self-referencing tree (`folders.parent_folder_id`) or one referenced from
 * outside (`files.folder_id`) fails whichever way a single DELETE is written.
 * Every inbound reference is therefore cleared to NULL before anything is
 * removed, and the removals run child-first.
 *
 * **R2 goes before D1**, matching the purge job and `deleteWorkspaceForUser`:
 * the rows are the only record of which objects exist, so losing them first
 * orphans bytes nothing can ever find again. A failure part-way leaves the
 * workspace intact and the operation retryable, which is the better half of the
 * trade.
 */

/** R2 accepts up to 1000 keys in one delete. */
const R2_DELETE_CHUNK = 1000;

export interface CascadeResult {
  /** R2 objects removed. Zero for a sandbox whose files were merged away first. */
  objectsDeleted: number;
}

/**
 * Delete every object belonging to a workspace, then every row.
 *
 * Takes the raw bindings rather than a workspace-scoped context on purpose:
 * this is the one operation whose subject is the workspace itself, so there is
 * nothing left to be scoped to once it finishes. The workspace ID is the only
 * thing it can name, and every statement below is constrained by it.
 */
export async function deleteWorkspaceCascade(
  db: D1Database,
  files: R2Bucket,
  workspaceId: string
): Promise<CascadeResult> {
  const objects = await db
    .prepare(`SELECT r2_object_key FROM files WHERE workspace_id = ?`)
    .bind(workspaceId)
    .all<{ r2_object_key: string | null }>();

  const keys = (objects.results ?? [])
    .map(row => row.r2_object_key)
    .filter((key): key is string => key !== null);

  for (let i = 0; i < keys.length; i += R2_DELETE_CHUNK) {
    await files.delete(keys.slice(i, i + R2_DELETE_CHUNK));
  }

  await db.batch([
    db.prepare(`UPDATE files SET folder_id = NULL WHERE workspace_id = ?`).bind(workspaceId),
    db
      .prepare(`UPDATE folders SET parent_folder_id = NULL WHERE workspace_id = ?`)
      .bind(workspaceId),
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

  return { objectsDeleted: keys.length };
}

/**
 * Remove a provisional org and its placeholder user, once nothing points at them.
 *
 * Only ever called after the sandbox workspace itself is gone or reparented.
 * Both deletes are conditional in SQL rather than checked first and then run:
 * the org goes only if it holds no workspaces, and the user goes only if they
 * are still flagged provisional and own no organizations. That way a race, a
 * retry, or a claim that reparented the workspace into a real account cannot
 * delete an organization somebody is actually using.
 *
 * `is_provisional = 1` is the hard gate on the user delete. A real person who
 * happened to end up owning an empty org must never be removed by a cleanup
 * path - that flag is only ever set by sandbox provisioning.
 */
export async function deleteProvisionalOwner(
  db: D1Database,
  orgId: string,
  userId: string
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM memberships
          WHERE org_id = ?
            AND NOT EXISTS (SELECT 1 FROM workspaces WHERE org_id = ?)`
      )
      .bind(orgId, orgId),
    db
      .prepare(
        `DELETE FROM organizations
          WHERE id = ?
            AND NOT EXISTS (SELECT 1 FROM workspaces WHERE org_id = ?)`
      )
      .bind(orgId, orgId),
    db
      .prepare(
        `DELETE FROM users
          WHERE id = ?
            AND is_provisional = 1
            AND NOT EXISTS (SELECT 1 FROM organizations WHERE owner_user_id = ?)`
      )
      .bind(userId, userId),
  ]);
}
