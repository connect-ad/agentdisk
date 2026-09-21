/**
 * Share link management — the authenticated half. The public half is in
 * `shares-public.ts`, kept apart so that "no credential reaches this file" is
 * a property of a whole file rather than of a branch inside one.
 *
 * One creator endpoint serves both kinds, so the plan check and the live count
 * exist in exactly one place and cannot disagree between files and folders.
 */

import { z } from "zod";
import { ApiError, forbidden, validationError } from "../lib/errors";
import { normalizePath } from "../lib/paths";
import { newId } from "../lib/ids";
import { assertScopedPath } from "../auth/scopes";
import { auditAndNotify } from "../lib/audit";
import { mintShareToken, resolveExpiry, shareUrl } from "../lib/shares";
import type { AuthContext } from "../middleware/auth";
import type { ShareRow } from "../db/shares";

const CreateSchema = z
  .object({
    fileId: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((body) => (body.fileId === undefined) !== (body.path === undefined), {
    message: "exactly one of fileId (a file) or path (a folder) is required",
  });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function toResource(row: ShareRow, dashboardUrl: string | undefined) {
  return {
    id: row.id,
    kind: row.kind,
    fileId: row.file_id,
    path: row.folder_path,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    // Cleartext by design — see migration 0016. A link nobody can copy twice
    // is not a share feature.
    url: shareUrl(dashboardUrl, row.token),
  };
}

export async function createShare(ctx: AuthContext, request: Request): Promise<Response> {
  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw validationError(parsed.error.issues[0]?.message ?? "Invalid request body.");
  }
  const body = parsed.data;

  // The entitlement, before any work. Counting live rows rather than reading a
  // flag means revoking frees a slot with no second bookkeeping step.
  const live = await ctx.db.shares.countLive(ctx.now);
  if (live >= ctx.limits.shareLinks) {
    throw forbidden(
      ctx.limits.shareLinks === 0
        ? "Share links aren't available on this plan. Upgrade to share files publicly."
        : "This workspace has used all of its share links. Revoke one, or upgrade for more.",
      { limit: "shareLinks", used: live, allowed: ctx.limits.shareLinks }
    );
  }

  const expiresAt = resolveExpiry(
    body.expiresAt === undefined ? undefined : Date.parse(body.expiresAt),
    ctx.now
  );

  let kind: "file" | "folder";
  let fileId: string | null = null;
  let folderPath: string | null = null;

  if (body.fileId !== undefined) {
    const row = await ctx.db.files.getById(body.fileId);
    if (row === null || row.status !== "active") {
      throw new ApiError("NOT_FOUND", "No such file.");
    }
    assertScopedPath(ctx.scope, "share", row.path);
    kind = "file";
    fileId = row.id;
  } else {
    folderPath = normalizePath(body.path as string);
    assertScopedPath(ctx.scope, "share", folderPath);
    kind = "folder";
  }

  const id = newId("shareLink", ctx.now);
  const { token, tokenHash } = await mintShareToken();
  // The actor as audit_events records one, for an agent and a person alike.
  const createdBy = ctx.identity.actorId;

  await ctx.db.shares.create({
    id,
    kind,
    fileId,
    folderPath,
    token,
    tokenHash,
    expiresAt,
    createdBy,
    now: ctx.now,
  });

  // Audited because the row is destroyed on revoke, so this event is the only
  // lasting record that something was made public. See the spec.
  auditAndNotify(ctx, request, "share.created", {
    resourceType: "share",
    resourceId: id,
    metadata: { kind, fileId, path: folderPath, expiresAt },
    webhookData: { id, kind },
  });

  const resource = toResource(
    {
      id,
      workspace_id: ctx.workspaceId,
      kind,
      file_id: fileId,
      folder_path: folderPath,
      token,
      token_hash: tokenHash,
      expires_at: expiresAt,
      created_by: createdBy,
      created_at: ctx.now,
    },
    ctx.dashboardUrl
  );

  return json({ share: resource, url: resource.url }, 201);
}

export async function listShares(ctx: AuthContext): Promise<Response> {
  const rows = await ctx.db.shares.listLive(ctx.now);
  return json({ shares: rows.map((row) => toResource(row, ctx.dashboardUrl)) });
}

export async function deleteShare(
  ctx: AuthContext,
  request: Request,
  shareId: string
): Promise<Response> {
  const removed = await ctx.db.shares.deleteById(shareId);
  if (!removed) {
    throw new ApiError("NOT_FOUND", "No such share link.");
  }

  auditAndNotify(ctx, request, "share.revoked", {
    resourceType: "share",
    resourceId: shareId,
    metadata: { reason: "revoked by owner" },
    webhookData: { id: shareId },
  });

  return json({ revoked: true });
}
