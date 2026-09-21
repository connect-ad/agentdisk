/**
 * The two routes in this product that serve a tenant's bytes with no
 * credential at all.
 *
 * Kept in their own file on purpose: "nothing here is authenticated" is a
 * property worth being able to see at the top of a file, rather than one
 * branch among many in a file full of routes that are.
 *
 * Every refusal is the same 404 with the same body. Expired, revoked, never
 * existed, wrong workspace, soft-deleted file, suspended workspace and a file
 * id outside the shared folder are indistinguishable to the caller — a
 * distinguishable failure is an oracle that confirms which tokens are real.
 * The reason goes to `internalReason`, which is logged and never serialized.
 */

import { ApiError } from "../lib/errors";
import { sha256Hex } from "../lib/keys";
import { escapeLikePattern } from "../lib/paths";
import { findShareByToken } from "../db/shares";
import { pathIsInside, SHARE_DOWNLOAD_TTL_SECONDS } from "../lib/shares";
import { presignDownload, redactPresigned, type R2SigningConfig } from "../storage/presign";
import type { FileRow } from "../db/types";

export interface PublicShareDeps {
  db: D1Database;
  signing: () => R2SigningConfig | null;
  requestId: string;
}

/** The one refusal. Never varies, whatever went wrong. */
function nothingHere(internalReason: string): ApiError {
  return new ApiError("NOT_FOUND", "This link isn't available.", { internalReason });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Resolve a token to its share, its workspace and the files it currently
 * exposes. Folder shares are live and recursive, resolved by PATH — never by
 * folder_id, because folders are created lazily and a file can sit inside one
 * with folder_id still NULL, which would silently under-share.
 */
async function resolve(deps: PublicShareDeps, token: string, now: number) {
  const share = await findShareByToken(deps.db, await sha256Hex(token), now);
  if (share === null) throw nothingHere("no live share for that token");

  const workspace = await deps.db
    .prepare(`SELECT id, name, status FROM workspaces WHERE id = ?`)
    .bind(share.workspace_id)
    .first<{ id: string; name: string; status: string }>();

  if (workspace === null || workspace.status !== "active") {
    throw nothingHere(`workspace ${share.workspace_id} is ${workspace?.status ?? "missing"}`);
  }

  let files: FileRow[];
  if (share.kind === "file") {
    const row = await deps.db
      .prepare(`SELECT * FROM files WHERE id = ? AND workspace_id = ? AND status = 'active'`)
      .bind(share.file_id, share.workspace_id)
      .first<FileRow>();
    if (row === null) throw nothingHere("shared file is missing or not active");
    files = [row];
  } else {
    const folderPath = share.folder_path as string;
    const { results } = await deps.db
      .prepare(
        `SELECT * FROM files
          WHERE workspace_id = ? AND status = 'active' AND path LIKE ? ESCAPE '\\'
          ORDER BY path`
      )
      .bind(share.workspace_id, `${escapeLikePattern(folderPath)}/%`)
      .all<FileRow>();
    // The LIKE narrows; pathIsInside decides. LIKE cannot express a segment
    // boundary, so it would also match shapes a future path-normalization
    // change let through.
    files = (results ?? []).filter((row) => pathIsInside(row.path, folderPath));
  }

  return { share, workspace, files };
}

export async function previewShare(
  deps: PublicShareDeps,
  token: string,
  now: number
): Promise<Response> {
  const { share, workspace, files } = await resolve(deps, token, now);

  return json({
    kind: share.kind,
    name: share.kind === "file" ? files[0]?.name : share.folder_path,
    workspaceName: workspace.name,
    expiresAt: new Date(share.expires_at).toISOString(),
    files: files.map((row) => ({
      id: row.id,
      name: row.name,
      path: row.path,
      sizeBytes: row.size_bytes,
      mimeType: row.mime_type,
    })),
  });
}

export async function downloadShared(
  deps: PublicShareDeps,
  token: string,
  fileId: string,
  now: number
): Promise<Response> {
  const { share, files } = await resolve(deps, token, now);

  // Containment. For a folder share this is the segment-boundary check; for a
  // file share it is an equality check the caller cannot route around. Both
  // are expressed as "is this id in the set this token exposes", which is one
  // rule rather than two that could disagree.
  const row = files.find((candidate) => candidate.id === fileId);
  if (row === undefined) throw nothingHere(`file ${fileId} is not inside share ${share.id}`);

  const config = deps.signing();
  if (config === null) throw nothingHere("presigning is not configured on this deployment");

  // The key as stored on the row, not one rebuilt from the ids. The row is
  // what the upload actually wrote, so a second derivation here would be a
  // second definition of the same fact, free to disagree with the first.
  const url = await presignDownload(config, row.r2_object_key, SHARE_DOWNLOAD_TTL_SECONDS);

  console.log(
    JSON.stringify({
      level: "info",
      requestId: deps.requestId,
      message: "issued presigned download for a public share",
      shareId: share.id,
      fileId: row.id,
      workspaceId: share.workspace_id,
      bytes: row.size_bytes,
      url: redactPresigned(url),
    })
  );

  return Response.redirect(url, 302);
}
