/**
 * Share link rows, bound to one workspace.
 *
 * Same discipline as WorkspaceScopedStorage: the workspace is fixed in the
 * constructor and every statement carries it, so there is no argument through
 * which a caller can name another tenant's links.
 *
 * `findShareByToken` is the one exception and is deliberately a module
 * function rather than a method — the public route has no workspace until the
 * token resolves, so the lookup that crosses the boundary is one named,
 * greppable function rather than a constructor that would accept any
 * workspace id at all.
 */

export interface ShareRow {
  id: string;
  workspace_id: string;
  kind: "file" | "folder";
  file_id: string | null;
  folder_path: string | null;
  token: string;
  token_hash: string;
  /** PBKDF2 of the link's password, or null for a link that needs none. */
  password_hash: string | null;
  expires_at: number;
  created_by: string;
  created_at: number;
}

export interface CreateShareInput {
  id: string;
  kind: "file" | "folder";
  fileId: string | null;
  folderPath: string | null;
  token: string;
  tokenHash: string;
  /** Absent or null: the link needs no password. */
  passwordHash?: string | null;
  expiresAt: number;
  createdBy: string;
  now: number;
}

export class WorkspaceScopedShares {
  constructor(
    private readonly db: D1Database,
    private readonly workspaceId: string
  ) {}

  async create(input: CreateShareInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO share_links
           (id, workspace_id, kind, file_id, folder_path, token, token_hash,
            password_hash, expires_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        this.workspaceId,
        input.kind,
        input.fileId,
        input.folderPath,
        input.token,
        input.tokenHash,
        input.passwordHash ?? null,
        input.expiresAt,
        input.createdBy,
        input.now
      )
      .run();
  }

  async listLive(now: number): Promise<ShareRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM share_links
          WHERE workspace_id = ? AND expires_at > ?
          ORDER BY created_at DESC`
      )
      .bind(this.workspaceId, now)
      .all<ShareRow>();
    return results ?? [];
  }

  async countLive(now: number): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM share_links WHERE workspace_id = ? AND expires_at > ?`)
      .bind(this.workspaceId, now)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** True if a row was removed. False means it was not this workspace's to remove. */
  async deleteById(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM share_links WHERE id = ? AND workspace_id = ?`)
      .bind(id, this.workspaceId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}

/** The public route's only way in. Expiry is part of the lookup, not a later check. */
export async function findShareByToken(
  db: D1Database,
  tokenHash: string,
  now: number
): Promise<ShareRow | null> {
  const row = await db
    .prepare(`SELECT * FROM share_links WHERE token_hash = ? AND expires_at > ?`)
    .bind(tokenHash, now)
    .first<ShareRow>();
  return row ?? null;
}
