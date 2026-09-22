/**
 * Workspace-scoped repositories - the tenant-isolation enforcement mechanism
 * (06 PART 16.1). This is the most security-critical file in the codebase.
 *
 * The invariant: `workspace_id` is bound in the CONSTRUCTOR and is never a
 * method parameter. A handler receives an already-scoped repository, never a
 * raw D1 binding, so omitting the workspace filter is not something a caller
 * can forget - there is no method that accepts a workspace ID at all.
 *
 * Lookups by ID are AND-ed with workspace_id deliberately: asking for another
 * workspace's row by its exact ID must return nothing, not that row.
 *
 * Rules for anyone editing this file:
 *   - never add a method that accepts a workspaceId argument
 *   - never build SQL by interpolating anything; always bind with ?
 *   - never expose the raw D1 binding
 */
import type {
  AgentRow,
  ApiKeyRow,
  AuditEventRow,
  FileRow,
  FolderRow,
  WebhookRow,
} from "./types";
import { escapeLikePattern } from "../lib/paths";
import { WorkspaceScopedShares } from "./shares";

/**
 * The two binds for "inside this path prefix", anchored to a segment boundary.
 *
 * `LIKE 'prefix%'` asks the wrong question. For a key scoped to `/agents/bot`
 * it also matches `/agents/bot-evil/secrets.txt`, which is precisely what
 * `scopeAllowsPath` refuses one row at a time - so the collection queries were
 * contradicting, in bulk, the boundary every single-resource handler enforces.
 * A prefix owns itself and everything beneath its separator, and nothing else.
 *
 * Returned as binds rather than as a SQL fragment on purpose: this file's rule
 * is that nothing is ever interpolated into a statement, and a helper that
 * returned text - even text built from an internal constant - would be the
 * first exception to it. The clause is written out literally at each call site
 * and is identical at all four.
 *
 * A root prefix owns the whole workspace, so it yields a pattern that matches
 * every path rather than a special-cased second statement. One SQL shape per
 * site, no branch to get wrong.
 */
function prefixBinds(pathPrefix: string): [exact: string, under: string] {
  if (pathPrefix === "" || pathPrefix === "/") return ["/", "%"];
  return [pathPrefix, `${escapeLikePattern(pathPrefix)}/%`];
}

abstract class WorkspaceScoped {
  constructor(
    protected readonly db: D1Database,
    protected readonly workspaceId: string
  ) {
    if (!workspaceId) {
      // A blank scope would make `workspace_id = ''` match nothing, which fails
      // safe - but it means an upstream bug produced an empty scope. Fail loudly
      // rather than quietly returning empty result sets forever.
      throw new Error("WorkspaceScoped repository constructed without a workspace ID.");
    }
  }
}

export class WorkspaceScopedFiles extends WorkspaceScoped {
  async getById(id: string): Promise<FileRow | null> {
    return this.db
      .prepare(`SELECT * FROM files WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`)
      .bind(this.workspaceId, id)
      .first<FileRow>();
  }

  async getByPath(path: string): Promise<FileRow | null> {
    return this.db
      .prepare(`SELECT * FROM files WHERE workspace_id = ? AND path = ? AND deleted_at IS NULL`)
      .bind(this.workspaceId, path)
      .first<FileRow>();
  }

  async listByPrefix(pathPrefix: string, limit = 100, offset = 0): Promise<FileRow[]> {
    const [exact, under] = prefixBinds(pathPrefix);
    const result = await this.db
      .prepare(
        `SELECT * FROM files
         WHERE workspace_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')
           AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .bind(this.workspaceId, exact, under, limit, offset)
      .all<FileRow>();
    return result.results ?? [];
  }

  /**
   * One page of a listing, keyset-paginated.
   *
   * The cursor is the last ID of the previous page and the order is `id DESC`.
   * That works because IDs are ULIDs, so string order *is* creation order and a
   * single total-ordered column can carry both the sort and the cursor. OFFSET
   * pagination would have been simpler to write and wrong in the way that only
   * shows up under concurrent writes: rows inserted mid-scan shift the window
   * and a client walking pages silently skips or repeats files.
   *
   * `limit + 1` rows are fetched so the caller can tell "this page is full"
   * from "there is another page" without a second COUNT query.
   */
  /**
   * Search by name, path, caption or tag, inside a path prefix.
   *
   * Two things this must never do, and both are the reason it lives here rather
   * than being assembled in a route. The prefix is applied in the same
   * statement as the match, so a query can never surface a file outside the
   * caller's scope by matching it - "filter afterwards" is how that leaks. And
   * the search term is escaped for LIKE, so a query containing `%` searches for
   * a literal percent sign rather than everything.
   */
  async search(
    pathPrefix: string,
    term: string,
    limit: number,
    cursor: string | null
  ): Promise<FileRow[]> {
    const [exact, under] = prefixBinds(pathPrefix);
    const termPattern = `%${escapeLikePattern(term)}%`;

    const sql = `SELECT DISTINCT f.* FROM files f
                   LEFT JOIN file_tags t ON t.file_id = f.id
                  WHERE f.workspace_id = ?
                    AND (f.path = ? OR f.path LIKE ? ESCAPE '\\')
                    AND f.deleted_at IS NULL
                    AND (f.name LIKE ? ESCAPE '\\'
                      OR f.path LIKE ? ESCAPE '\\'
                      OR f.caption LIKE ? ESCAPE '\\'
                      OR t.tag LIKE ? ESCAPE '\\')
                    ${cursor === null ? "" : "AND f.id < ?"}
                  ORDER BY f.id DESC
                  LIMIT ?`;

    const binds: (string | number)[] = [
      this.workspaceId,
      exact,
      under,
      termPattern,
      termPattern,
      termPattern,
      termPattern,
    ];
    if (cursor !== null) binds.push(cursor);
    binds.push(limit);

    const result = await this.db.prepare(sql).bind(...binds).all<FileRow>();
    return result.results ?? [];
  }

  async listPage(pathPrefix: string, limit: number, cursor: string | null): Promise<FileRow[]> {
    const [exact, under] = prefixBinds(pathPrefix);
    const statement =
      cursor === null
        ? this.db
            .prepare(
              `SELECT * FROM files
                WHERE workspace_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')
                  AND deleted_at IS NULL
                ORDER BY id DESC LIMIT ?`
            )
            .bind(this.workspaceId, exact, under, limit + 1)
        : this.db
            .prepare(
              `SELECT * FROM files
                WHERE workspace_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')
                  AND deleted_at IS NULL
                  AND id < ?
                ORDER BY id DESC LIMIT ?`
            )
            .bind(this.workspaceId, exact, under, cursor, limit + 1);
    const result = await statement.all<FileRow>();
    return result.results ?? [];
  }

  /**
   * An upload that was started and never finished (12.2 step 7).
   *
   * Only ever applied to a row still in `pending`: a file that reached `active`
   * has bytes in R2 and must not be walked back by a late failure report.
   */
  async markFailed(id: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE files SET status = 'failed', updated_at = ?
         WHERE workspace_id = ? AND id = ? AND status = 'pending'`
      )
      .bind(now, this.workspaceId, id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async insert(row: FileRow): Promise<void> {
    if (row.workspace_id !== this.workspaceId) {
      // Defence in depth: the caller built a row for another workspace. Writing
      // it would be a cross-tenant write even though every read is scoped, so
      // refuse rather than silently rewriting the field.
      throw new Error("Refusing to insert a file row belonging to another workspace.");
    }
    await this.db
      .prepare(
        `INSERT INTO files (
           id, workspace_id, folder_id, name, path, r2_object_key, size_bytes,
           mime_type, checksum_sha256, caption, custom_metadata, status,
           created_by, created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.id, this.workspaceId, row.folder_id, row.name, row.path, row.r2_object_key,
        row.size_bytes, row.mime_type, row.checksum_sha256, row.caption,
        row.custom_metadata, row.status, row.created_by, row.created_at,
        row.updated_at, row.deleted_at
      )
      .run();
  }

  async markActive(id: string, sizeBytes: number, checksum: string | null, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE files SET status = 'active', size_bytes = ?, checksum_sha256 = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND status = 'pending'`
      )
      .bind(sizeBytes, checksum, now, this.workspaceId, id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * Mark a row deleted, as the first of the three steps a delete takes (12.5).
   *
   * Deleting is permanent, so this is not a state anybody is meant to sit in -
   * it is the marker that makes the next two steps recoverable. Between here
   * and `hardDelete` the row is already invisible to every read in the system,
   * and if the R2 delete or the row delete fails in between, the marker is what
   * `reapStrandedFiles` finds to finish the job on the next tick.
   */
  async markDeleted(id: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE files SET status = 'deleted', deleted_at = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`
      )
      .bind(now, now, this.workspaceId, id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * Remove the row for good, once its object is gone.
   *
   * `file_tags.file_id` references `files(id)` with no ON DELETE action, so the
   * tags go first or SQLite refuses the parent. `share_links.file_id` does
   * carry ON DELETE CASCADE, which is deliberate rather than incidental: a
   * destroyed file's share links must not outlive it pointing at nothing.
   */
  async hardDelete(id: string): Promise<boolean> {
    // Scoped on the way in, so a file ID from another workspace deletes
    // nothing - the same guarantee every other method here gives.
    const owned = await this.db
      .prepare(`SELECT 1 FROM files WHERE workspace_id = ? AND id = ?`)
      .bind(this.workspaceId, id)
      .first<{ 1: number }>();
    if (owned === null) return false;

    await this.db.batch([
      this.db.prepare(`DELETE FROM file_tags WHERE file_id = ?`).bind(id),
      this.db.prepare(`DELETE FROM files WHERE workspace_id = ? AND id = ?`).bind(this.workspaceId, id),
    ]);
    return true;
  }

  async updateMetadata(
    id: string,
    caption: string | null,
    customMetadata: string | null,
    now: number
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE files SET caption = ?, custom_metadata = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`
      )
      .bind(caption, customMetadata, now, this.workspaceId, id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async getTags(fileId: string): Promise<string[]> {
    const result = await this.db
      .prepare(
        `SELECT t.tag FROM file_tags t
           JOIN files f ON f.id = t.file_id
          WHERE t.file_id = ? AND f.workspace_id = ?
          ORDER BY t.tag`
      )
      .bind(fileId, this.workspaceId)
      .all<{ tag: string }>();
    return (result.results ?? []).map((row) => row.tag);
  }

  /**
   * Replace a file's tags.
   *
   * `file_tags` has no workspace_id column of its own - it is scoped through
   * the file it points at. So every statement here re-proves that ownership in
   * SQL (`WHERE EXISTS (... files ... workspace_id = ?)`) rather than trusting
   * that the caller looked the file up through a scoped repository first. A
   * write that names another workspace's file affects zero rows instead of
   * tagging it.
   */
  async setTags(fileId: string, tags: string[]): Promise<void> {
    const unique = [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag !== ""))];

    const statements = [
      this.db
        .prepare(
          `DELETE FROM file_tags
            WHERE file_id = ?
              AND EXISTS (SELECT 1 FROM files WHERE id = ? AND workspace_id = ?)`
        )
        .bind(fileId, fileId, this.workspaceId),
      ...unique.map((tag) =>
        this.db
          .prepare(
            `INSERT OR IGNORE INTO file_tags (file_id, tag)
             SELECT ?, ?
              WHERE EXISTS (SELECT 1 FROM files WHERE id = ? AND workspace_id = ?)`
          )
          .bind(fileId, tag, fileId, this.workspaceId)
      ),
    ];

    // One batch, so a partial tag set can never be left behind by a failure
    // between the delete and the inserts.
    await this.db.batch(statements);
  }

  /** Move or rename: a pure metadata update, zero R2 operations (12.1). */
  async move(id: string, newPath: string, newName: string, folderId: string | null, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE files SET path = ?, name = ?, folder_id = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`
      )
      .bind(newPath, newName, folderId, now, this.workspaceId, id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}

export class WorkspaceScopedFolders extends WorkspaceScoped {
  async getById(id: string): Promise<FolderRow | null> {
    return this.db
      .prepare(`SELECT * FROM folders WHERE workspace_id = ? AND id = ?`)
      .bind(this.workspaceId, id)
      .first<FolderRow>();
  }

  async getByPath(path: string): Promise<FolderRow | null> {
    return this.db
      .prepare(`SELECT * FROM folders WHERE workspace_id = ? AND path = ?`)
      .bind(this.workspaceId, path)
      .first<FolderRow>();
  }

  async listChildren(parentFolderId: string | null): Promise<FolderRow[]> {
    const statement =
      parentFolderId === null
        ? this.db
            .prepare(`SELECT * FROM folders WHERE workspace_id = ? AND parent_folder_id IS NULL ORDER BY name`)
            .bind(this.workspaceId)
        : this.db
            .prepare(`SELECT * FROM folders WHERE workspace_id = ? AND parent_folder_id = ? ORDER BY name`)
            .bind(this.workspaceId, parentFolderId);
    const result = await statement.all<FolderRow>();
    return result.results ?? [];
  }

  async insert(row: FolderRow): Promise<void> {
    if (row.workspace_id !== this.workspaceId) {
      throw new Error("Refusing to insert a folder row belonging to another workspace.");
    }
    await this.db
      .prepare(
        `INSERT INTO folders (id, workspace_id, parent_folder_id, name, path, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(row.id, this.workspaceId, row.parent_folder_id, row.name, row.path, row.created_by, row.created_at)
      .run();
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM folders WHERE workspace_id = ? AND id = ?`)
      .bind(this.workspaceId, id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async listByPrefix(pathPrefix: string): Promise<FolderRow[]> {
    const [exact, under] = prefixBinds(pathPrefix);
    const result = await this.db
      .prepare(
        `SELECT * FROM folders
          WHERE workspace_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')
          ORDER BY path`
      )
      .bind(this.workspaceId, exact, under)
      .all<FolderRow>();
    return result.results ?? [];
  }

  /**
   * Whether anything lives under this folder's path.
   *
   * Checked against paths rather than folder_id because a file may sit at a
   * path under a folder without ever having had its folder_id populated -
   * folders are created lazily, so folder_id is an optimisation and path is
   * the truth. Deleting a folder whose subtree is non-empty on that basis
   * would orphan real files.
   */
  async hasDescendants(path: string): Promise<boolean> {
    const like = `${escapeLikePattern(path)}/%`;
    const file = await this.db
      .prepare(
        `SELECT 1 FROM files
          WHERE workspace_id = ? AND path LIKE ? ESCAPE '\\' AND deleted_at IS NULL
          LIMIT 1`
      )
      .bind(this.workspaceId, like)
      .first<{ 1: number }>();
    if (file !== null) return true;

    const folder = await this.db
      .prepare(
        `SELECT 1 FROM folders
          WHERE workspace_id = ? AND path LIKE ? ESCAPE '\\'
          LIMIT 1`
      )
      .bind(this.workspaceId, like)
      .first<{ 1: number }>();
    return folder !== null;
  }

  /**
   * Delete a folder and everything beneath it (12.5).
   *
   * This marks the files and destroys the folder rows; the caller finishes the
   * files off, because destroying them means deleting R2 objects and this
   * repository has no storage binding by design. The returned `marked` list is
   * that handoff - ids and object keys, so the caller needs no second query.
   */
  async deleteRecursive(
    path: string,
    now: number
  ): Promise<{ files: number; bytes: number; marked: { id: string; r2_object_key: string | null }[] }> {
    const like = `${escapeLikePattern(path)}/%`;

    // Read before marking, for two reasons now: the caller needs the quota to
    // release, and it needs the object keys. After the UPDATE below these rows
    // are still findable by `deleted_at`, but a request that dies between the
    // two would leave them to the reaper rather than to a second query here.
    const doomed = await this.db
      .prepare(
        `SELECT id, r2_object_key, size_bytes
           FROM files
          WHERE workspace_id = ? AND path LIKE ? ESCAPE '\\'
            AND deleted_at IS NULL AND status = 'active'`
      )
      .bind(this.workspaceId, like)
      .all<{ id: string; r2_object_key: string | null; size_bytes: number }>();

    const marked = doomed.results ?? [];
    const totals = {
      files: marked.length,
      bytes: marked.reduce((sum, row) => sum + row.size_bytes, 0),
    };

    // Order does not save us here: within one statement SQLite deletes rows in
    // an arbitrary order and foreign keys are checked immediately, so deleting
    // a subtree that references itself (folders.parent_folder_id) or is
    // referenced by files (files.folder_id) fails whichever way it is written.
    // So every reference INTO the subtree is cleared first, and only then are
    // the rows removed. Clearing folder_id costs nothing real: it is an
    // optimisation over `path`, which is the actual truth about where a file
    // lives, and these files are being deleted anyway.
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE files SET folder_id = NULL
            WHERE workspace_id = ?
              AND folder_id IN (
                SELECT id FROM folders
                 WHERE workspace_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')
              )`
        )
        .bind(this.workspaceId, this.workspaceId, path, like),
      this.db
        .prepare(
          `UPDATE files SET status = 'deleted', deleted_at = ?, updated_at = ?
            WHERE workspace_id = ? AND path LIKE ? ESCAPE '\\' AND deleted_at IS NULL`
        )
        .bind(now, now, this.workspaceId, like),
      this.db
        .prepare(
          `UPDATE folders SET parent_folder_id = NULL
            WHERE workspace_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')`
        )
        .bind(this.workspaceId, path, like),
      this.db
        .prepare(
          `DELETE FROM folders
            WHERE workspace_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')`
        )
        .bind(this.workspaceId, path, like),
    ]);

    return {
      files: totals.files,
      bytes: totals.bytes,
      marked: marked.map((row) => ({ id: row.id, r2_object_key: row.r2_object_key })),
    };
  }
}

export class WorkspaceScopedAgents extends WorkspaceScoped {
  async getById(id: string): Promise<AgentRow | null> {
    return this.db
      .prepare(`SELECT * FROM agents WHERE workspace_id = ? AND id = ?`)
      .bind(this.workspaceId, id)
      .first<AgentRow>();
  }

  async list(): Promise<AgentRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM agents
          WHERE workspace_id = ? AND status != 'deleted'
          ORDER BY created_at DESC`
      )
      .bind(this.workspaceId)
      .all<AgentRow>();
    return result.results ?? [];
  }

  async insert(row: AgentRow): Promise<void> {
    if (row.workspace_id !== this.workspaceId) {
      throw new Error("Refusing to insert an agent row belonging to another workspace.");
    }
    await this.db
      .prepare(
        `INSERT INTO agents (id, workspace_id, name, description, status, created_by_user_id, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(row.id, this.workspaceId, row.name, row.description, row.status,
            row.created_by_user_id, row.last_seen_at, row.created_at)
      .run();
  }

  /**
   * Rename, re-describe, or enable/disable. Only the fields given are touched.
   *
   * Disabling is the point of `status`: a disabled agent's keys stop working
   * immediately, because authentication checks the agent's status on every
   * request rather than trusting that whoever disabled it also remembered to
   * revoke each of its keys.
   */
  async update(
    id: string,
    changes: { name?: string; description?: string | null; status?: string }
  ): Promise<boolean> {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (changes.name !== undefined) { sets.push("name = ?"); values.push(changes.name); }
    if (changes.description !== undefined) {
      sets.push("description = ?");
      values.push(changes.description);
    }
    if (changes.status !== undefined) { sets.push("status = ?"); values.push(changes.status); }
    if (sets.length === 0) return false;

    const result = await this.db
      .prepare(`UPDATE agents SET ${sets.join(", ")} WHERE workspace_id = ? AND id = ?`)
      .bind(...values, this.workspaceId, id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * Soft delete, and still soft now that the keys go with it.
   *
   * The original reason was the foreign key: `api_keys.agent_id` references
   * this row, so a hard DELETE failed the moment the agent had ever held a key.
   * `deleteForAgent` clears that, and the route calls it first - but the row
   * stays anyway, because an agent id is what `audit_events.actor_id` holds for
   * every call its keys ever made. Remove the row and that history resolves to
   * nothing; the one thing a deletion must not do is erase what the thing did
   * before it was deleted.
   *
   * Marking it deleted also keeps the status check at authentication working (a
   * deleted agent is not active, so any key that somehow survived is refused)
   * and takes the agent out of every list.
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE agents SET status = 'deleted'
          WHERE workspace_id = ? AND id = ? AND status != 'deleted'`
      )
      .bind(this.workspaceId, id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}

export class WorkspaceScopedApiKeys extends WorkspaceScoped {
  async list(): Promise<ApiKeyRow[]> {
    const result = await this.db
      .prepare(`SELECT * FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC`)
      .bind(this.workspaceId)
      .all<ApiKeyRow>();
    return result.results ?? [];
  }

  async getById(id: string): Promise<ApiKeyRow | null> {
    return this.db
      .prepare(`SELECT * FROM api_keys WHERE workspace_id = ? AND id = ?`)
      .bind(this.workspaceId, id)
      .first<ApiKeyRow>();
  }

  async insert(row: ApiKeyRow): Promise<void> {
    if (row.workspace_id !== this.workspaceId) {
      throw new Error("Refusing to insert an API key row belonging to another workspace.");
    }
    await this.db
      .prepare(
        `INSERT INTO api_keys
           (id, workspace_id, agent_id, name, key_prefix, key_last_four, key_hash,
            key_ciphertext, scopes, created_by_user_id, parent_key_id, expires_at,
            last_used_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
      )
      .bind(
        row.id, this.workspaceId, row.agent_id, row.name, row.key_prefix,
        row.key_last_four, row.key_hash, row.key_ciphertext, row.scopes,
        row.created_by_user_id, row.parent_key_id, row.expires_at, row.created_at
      )
      .run();
  }

  /** Keys belonging to one agent, for the cascade when that agent is deleted. */
  async listForAgent(agentId: string): Promise<ApiKeyRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM api_keys WHERE workspace_id = ? AND agent_id = ? ORDER BY created_at DESC`
      )
      .bind(this.workspaceId, agentId)
      .all<ApiKeyRow>();
    return result.results ?? [];
  }

  async revoke(id: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE api_keys SET revoked_at = ? WHERE workspace_id = ? AND id = ? AND revoked_at IS NULL`)
      .bind(now, this.workspaceId, id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * Delete every key belonging to one agent, live or not.
   *
   * Used when an agent is deleted. Revoking them was enough to stop them
   * authenticating, but it left the rows in the key list under an agent that no
   * longer exists - a row nobody can act on, naming an agent that resolves to
   * nothing. Deleting the agent deletes its credentials with it.
   *
   * What is given up is the join from an old `audit_events` row back to the key
   * that made it. The events themselves survive: `resource_id` is plain text
   * with no foreign key, so the history still says which key id did what, it
   * just cannot be resolved to a name any more.
   */
  async deleteForAgent(agentId: string): Promise<number> {
    // The inbound foreign key first. A key minted by one of these keys carries
    // its id in `parent_key_id`, and SQLite checks that reference immediately,
    // so the DELETE below fails while any child points at a row it removes.
    // The child is somebody's live credential and is kept: `parent_key_id` is
    // provenance, not authority, and NULL is exactly what "minted by a key that
    // no longer exists" looks like.
    //
    // The child is not constrained to this workspace, because a claim merge
    // repoints a key row into another one and can leave the two ends apart.
    // This still names no other tenant's row directly - it clears pointers at
    // rows this workspace is deleting, and touches nothing else about them.
    await this.db
      .prepare(
        `UPDATE api_keys SET parent_key_id = NULL
          WHERE parent_key_id IN
            (SELECT id FROM api_keys WHERE workspace_id = ? AND agent_id = ?)`
      )
      .bind(this.workspaceId, agentId)
      .run();

    const result = await this.db
      .prepare(`DELETE FROM api_keys WHERE workspace_id = ? AND agent_id = ?`)
      .bind(this.workspaceId, agentId)
      .run();
    return result.meta.changes ?? 0;
  }
}

/**
 * The customer's own webhook endpoints.
 *
 * `secret` is selected here because the repository is the wrong place to decide
 * what a caller may see - the route strips it, and does so in exactly one
 * function (`toResource`) so there is a single place to get that right.
 */
export class WorkspaceScopedWebhooks extends WorkspaceScoped {
  async list(): Promise<WebhookRow[]> {
    const result = await this.db
      .prepare(`SELECT * FROM webhooks WHERE workspace_id = ? ORDER BY created_at DESC`)
      .bind(this.workspaceId)
      .all<WebhookRow>();
    return result.results ?? [];
  }

  async getById(id: string): Promise<WebhookRow | null> {
    return this.db
      .prepare(`SELECT * FROM webhooks WHERE workspace_id = ? AND id = ?`)
      .bind(this.workspaceId, id)
      .first<WebhookRow>();
  }

  async insert(row: WebhookRow): Promise<void> {
    if (row.workspace_id !== this.workspaceId) {
      throw new Error("Refusing to insert a webhook belonging to another workspace.");
    }
    await this.db
      .prepare(
        `INSERT INTO webhooks (id, workspace_id, url, secret, events, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(row.id, this.workspaceId, row.url, row.secret, row.events, row.status, row.created_at)
      .run();
  }

  async update(
    id: string,
    changes: { events?: string; status?: string }
  ): Promise<boolean> {
    const sets: string[] = [];
    const values: string[] = [];
    if (changes.events !== undefined) { sets.push("events = ?"); values.push(changes.events); }
    if (changes.status !== undefined) { sets.push("status = ?"); values.push(changes.status); }
    if (sets.length === 0) return false;

    const result = await this.db
      .prepare(`UPDATE webhooks SET ${sets.join(", ")} WHERE workspace_id = ? AND id = ?`)
      .bind(...values, this.workspaceId, id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM webhooks WHERE workspace_id = ? AND id = ?`)
      .bind(this.workspaceId, id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}

export class WorkspaceScopedAuditEvents extends WorkspaceScoped {
  async append(row: AuditEventRow): Promise<void> {
    if (row.workspace_id !== this.workspaceId) {
      throw new Error("Refusing to append an audit event belonging to another workspace.");
    }
    await this.db
      .prepare(
        `INSERT INTO audit_events (
           id, workspace_id, actor_type, actor_id, action, resource_type,
           resource_id, result, ip, client, request_id, metadata, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(row.id, this.workspaceId, row.actor_type, row.actor_id, row.action,
            row.resource_type, row.resource_id, row.result, row.ip, row.client,
            row.request_id, row.metadata, row.created_at)
      .run();
  }

  async list(limit = 50): Promise<AuditEventRow[]> {
    const result = await this.db
      .prepare(`SELECT * FROM audit_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(this.workspaceId, limit)
      .all<AuditEventRow>();
    return result.results ?? [];
  }
}

/**
 * The denormalized usage counters (05 PART 11.1) - at both levels.
 *
 * Scoped like everything else: the workspace ID is bound in the constructor, so
 * no caller can adjust another workspace's quota. The organization is reached
 * through a subquery on that same bound ID rather than taken as an argument,
 * which keeps the property intact - there is no parameter through which to
 * name another tenant's account, exactly as there is none for its bytes.
 *
 * **Two rows, because two scopes.** Storage and files are the subscription's
 * allowance and are enforced against the organization (migration 0017), so the
 * org counter is the one the quota check actually reads; the workspace copy
 * survives because a person looking at one workspace wants to know what *it*
 * holds. Egress is a period counter with no account-level period to reset on,
 * so it stays where it was.
 *
 * Sent as a `batch`, which D1 runs as one implicit transaction. Two separate
 * `run()` calls could leave the account counted and the workspace not, and the
 * drift would then sit there until the hourly reconciler happened to look -
 * with every write in between decided on the wrong number.
 *
 * Deltas are applied with `MAX(0, current + delta)` rather than a bare add. The
 * counters are denormalized, the reconciliation job (10.8) is what makes them
 * eventually true, and a transient double-decrement must not leave a workspace
 * with negative usage that then reads as free storage.
 */
export class WorkspaceScopedCounters extends WorkspaceScoped {
  async apply(delta: { bytes?: number; files?: number; egressBytes?: number }, now: number): Promise<void> {
    const bytes = delta.bytes ?? 0;
    const files = delta.files ?? 0;
    const egress = delta.egressBytes ?? 0;
    if (bytes === 0 && files === 0 && egress === 0) return;

    const statements = [
      this.db
        .prepare(
          `UPDATE workspaces
              SET storage_bytes_used  = MAX(0, storage_bytes_used + ?),
                  file_count          = MAX(0, file_count + ?),
                  egress_bytes_period = MAX(0, egress_bytes_period + ?),
                  updated_at          = ?
            WHERE id = ?`
        )
        .bind(bytes, files, egress, now, this.workspaceId),
    ];

    // Skipped entirely for an egress-only delta, which is the common read path.
    // Egress does not move the account counters, so touching `organizations`
    // there would be a write per download for a number that did not change.
    if (bytes !== 0 || files !== 0) {
      statements.push(
        this.db
          .prepare(
            `UPDATE organizations
                SET storage_bytes_used = MAX(0, storage_bytes_used + ?),
                    file_count         = MAX(0, file_count + ?),
                    updated_at         = ?
              WHERE id = (SELECT org_id FROM workspaces WHERE id = ?)`
          )
          .bind(bytes, files, now, this.workspaceId)
      );
    }

    await this.db.batch(statements);
  }
}

/**
 * The workspace row's own editable settings - as opposed to its contents, which
 * every other repository here covers.
 *
 * Bound like the rest, so no caller can rename another tenant's workspace.
 *
 * **`slug` is deliberately not touched.** It is derived once at creation and a
 * rename leaves it alone, because the dashboard has always promised that
 * renaming breaks no URL - and a slug that followed the name would silently
 * invalidate every bookmark and every link somebody had shared. The ID remains
 * the identifier either way.
 */
export class WorkspaceScopedSettings extends WorkspaceScoped {
  async rename(name: string, now: number): Promise<void> {
    await this.db
      .prepare(`UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?`)
      .bind(name, now, this.workspaceId)
      .run();
  }
}

/**
 * The single place a request's repositories are built. Called once per request,
 * after authorization has resolved which workspace the caller may act in -
 * never from a client-supplied field.
 */
export function createWorkspaceContext(db: D1Database, workspaceId: string) {
  return {
    files: new WorkspaceScopedFiles(db, workspaceId),
    folders: new WorkspaceScopedFolders(db, workspaceId),
    agents: new WorkspaceScopedAgents(db, workspaceId),
    apiKeys: new WorkspaceScopedApiKeys(db, workspaceId),
    webhooks: new WorkspaceScopedWebhooks(db, workspaceId),
    auditEvents: new WorkspaceScopedAuditEvents(db, workspaceId),
    counters: new WorkspaceScopedCounters(db, workspaceId),
    settings: new WorkspaceScopedSettings(db, workspaceId),
    // Bound here like every other repository, rather than handed a raw D1
    // binding at the call site. The public share route needs a lookup that
    // crosses the workspace boundary; that one lives in db/shares.ts as a
    // named module function, deliberately outside this context.
    shares: new WorkspaceScopedShares(db, workspaceId),
  };
}

export type WorkspaceContext = ReturnType<typeof createWorkspaceContext>;
