/**
 * The one query in this codebase that is not workspace-scoped, and the comment
 * explaining why it is allowed to exist.
 *
 * Authentication is what *determines* the caller's workspace - the workspace ID
 * is read off the key row. So this lookup cannot already be scoped to a
 * workspace without assuming the answer. Everything downstream of it is scoped,
 * built from the row this returns.
 *
 * Do not add another function here. If you find yourself wanting an unscoped
 * read of files, folders, agents or audit events, the answer is no: use
 * createWorkspaceContext with the workspace ID this module produced.
 */

import type { ApiKeyRow, WorkspaceRow } from "./types";

/**
 * Look up a key by the SHA-256 of the presented token.
 *
 * Lookup is by hash, never by prefix-then-scan: key_hash is unique-indexed, so
 * this is a single index probe regardless of how many keys exist. Revocation
 * and expiry are deliberately *not* filtered in SQL - the caller checks them,
 * so that a revoked key and an unknown key take the same code path and the same
 * number of queries.
 */
export async function findApiKeyByHash(
  db: D1Database,
  keyHash: string
): Promise<ApiKeyRow | null> {
  return db
    .prepare(`SELECT * FROM api_keys WHERE key_hash = ?`)
    .bind(keyHash)
    .first<ApiKeyRow>();
}

/**
 * The workspace a resolved key belongs to, with its org's plan joined on.
 *
 * The join is here rather than in a second query because every authenticated
 * request needs both: the workspace row carries the usage counters and the plan
 * decides what they are measured against. Two queries would double the D1 round
 * trips on the hot path to learn one number.
 */
export interface WorkspaceWithPlan extends WorkspaceRow {
  org_plan: string;
}

export async function findWorkspaceById(
  db: D1Database,
  workspaceId: string
): Promise<WorkspaceWithPlan | null> {
  return db
    .prepare(
      `SELECT w.*, o.plan AS org_plan
         FROM workspaces w
         JOIN organizations o ON o.id = w.org_id
        WHERE w.id = ?`
    )
    .bind(workspaceId)
    .first<WorkspaceWithPlan>();
}

/**
 * How stale last_used_at is allowed to get before we spend a write on it.
 *
 * Writing it on every request would put a D1 write in the hot path of every
 * authenticated call, which is both the slowest and the most expensive thing in
 * the request. A minute of granularity is plenty for "when did this key last
 * work?" in the dashboard, and it collapses a per-request write into a
 * per-minute one for a busy key.
 */
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export function shouldTouchLastUsed(row: Pick<ApiKeyRow, "last_used_at">, now: number): boolean {
  return row.last_used_at === null || now - row.last_used_at >= LAST_USED_WRITE_INTERVAL_MS;
}

/** Record that a key authenticated. Safe to run outside the response path. */
export async function touchLastUsed(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).bind(now, id).run();
}
