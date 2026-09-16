/**
 * Folder endpoints - 05 PART 13's table.
 *
 * Folders here are metadata, not containers. A file's `path` is the truth; a
 * folder row exists so a listing can show an empty directory and so the UI has
 * something to hang a name on. That is why `folder_id` on a file is nullable
 * and populated opportunistically: a file can be created at a deep path with no
 * folder rows anywhere above it, and everything still works.
 *
 * The consequence that matters is in deletion. Emptiness is decided by PATH,
 * not by `folder_id`, because a file whose folder_id was never populated is
 * still really inside that folder. Asking the wrong question there would let a
 * "delete empty folder" call orphan live files.
 */

import { z } from "zod";
import { ApiError, validationError } from "../lib/errors";
import { basename, dirname, normalizePath } from "../lib/paths";
import { assertScope, assertScopedPath } from "../auth/scopes";
import { assertWithinQuota } from "../lib/quota";
import { newId } from "../lib/ids";
import { effectiveListPrefix } from "./files";
import type { AuthContext } from "../middleware/auth";
import type { FolderRow } from "../db/types";

const CreateSchema = z.object({
  path: z.string().min(1, "path is required"),
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export interface FolderResource {
  id: string;
  workspaceId: string;
  path: string;
  name: string;
  parentFolderId: string | null;
  createdBy: string;
  createdAt: string;
}

export function toFolderResource(row: FolderRow): FolderResource {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    name: row.name,
    parentFolderId: row.parent_folder_id,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * POST /v1/folders
 *
 * Creates missing ancestors as well, because the alternative - refusing until
 * the client has created every level in order - is a worse API for the agent
 * callers this product is for, and produces exactly the same rows.
 */
export async function createFolder(ctx: AuthContext, request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw validationError("Request body must be JSON.");
  }

  const parsed = CreateSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationError(parsed.error.issues[0]?.message ?? "Invalid request body.", {
      fields: parsed.error.issues.map((issue) => issue.path.join(".")),
    });
  }

  const path = assertScopedPath(ctx.scope, "write", parsed.data.path);
  if (path === "/") {
    throw validationError("The workspace root already exists.");
  }

  const existing = await ctx.db.folders.getByPath(path);
  if (existing !== null) {
    throw new ApiError("CONFLICT", "A folder already exists at that path.", {
      details: { path },
    });
  }

  // Build the chain root-downwards so each row's parent already exists.
  const segments = path.split("/").filter((segment) => segment !== "");
  let parentId: string | null = null;
  let created: FolderRow | null = null;

  for (let depth = 1; depth <= segments.length; depth++) {
    const ancestorPath = `/${segments.slice(0, depth).join("/")}`;
    const found = await ctx.db.folders.getByPath(ancestorPath);
    if (found !== null) {
      parentId = found.id;
      created = found;
      continue;
    }

    // Every ancestor is inside the requested path, so a scope that allows the
    // leaf allows all of them - but assert rather than reason about it.
    assertScope(ctx.scope, "write", ancestorPath);

    const row: FolderRow = {
      id: newId("folder", ctx.now),
      workspace_id: ctx.workspaceId,
      parent_folder_id: parentId,
      name: basename(ancestorPath),
      path: ancestorPath,
      created_by: ctx.identity.actorId,
      created_at: ctx.now,
    };
    await ctx.db.folders.insert(row);
    parentId = row.id;
    created = row;
  }

  if (created === null) {
    throw new ApiError("INTERNAL_ERROR", "Something went wrong on our end.", {
      internalReason: `folder creation for ${path} produced no row`,
    });
  }
  return json({ folder: toFolderResource(created) }, 201);
}

/** GET /v1/folders?path= */
export async function listFolders(ctx: AuthContext, request: Request): Promise<Response> {
  assertScope(ctx.scope, "list");

  const url = new URL(request.url);
  const rawPath = url.searchParams.get("path");
  let requested: string | null = null;
  if (rawPath !== null) {
    try {
      requested = normalizePath(rawPath);
    } catch (err) {
      throw new ApiError("VALIDATION_ERROR", err instanceof Error ? err.message : "Invalid path.");
    }
  }

  // Same reconciliation as file listing: narrower wins, disjoint is refused,
  // and the result is a SQL prefix rather than a post-filter.
  const prefix = effectiveListPrefix(ctx.scope.pathPrefix, requested);
  const rows = await ctx.db.folders.listByPrefix(prefix);

  return json({ folders: rows.map(toFolderResource) });
}

/**
 * DELETE /v1/folders/:id
 *
 * 13's table: "blocked (409) if non-empty unless ?recursive=true". Refusing by
 * default is the point - a folder delete that silently takes a subtree with it
 * is the destructive operation people report as data loss.
 */
export async function deleteFolder(ctx: AuthContext, request: Request, folderId: string): Promise<Response> {
  const row = await ctx.db.folders.getById(folderId);
  if (row === null) {
    throw new ApiError("NOT_FOUND", "No such folder.");
  }
  assertScope(ctx.scope, "delete", row.path);

  const url = new URL(request.url);
  const recursive = url.searchParams.get("recursive") === "true";

  if (!recursive) {
    if (await ctx.db.folders.hasDescendants(row.path)) {
      throw new ApiError("CONFLICT", "That folder is not empty.", {
        details: { path: row.path, hint: "Pass ?recursive=true to delete its contents too." },
      });
    }
    await ctx.db.folders.delete(folderId);
    return json({ id: folderId, deleted: true, files: 0 });
  }

  // Files are soft-deleted, exactly as a single delete would (10.7), so a
  // recursive delete stays recoverable inside the grace window rather than
  // being the one destructive path with no undo.
  const removed = await ctx.db.folders.deleteRecursive(row.path, ctx.now);
  if (removed.files > 0 || removed.bytes > 0) {
    await ctx.db.counters.apply({ bytes: -removed.bytes, files: -removed.files }, ctx.now);
  }

  return json({ id: folderId, deleted: true, files: removed.files, bytes: removed.bytes });
}

/** Shared by move and copy: validate a destination that must not be occupied. */
async function destinationFor(ctx: AuthContext, rawPath: unknown): Promise<string> {
  if (typeof rawPath !== "string" || rawPath === "") {
    throw validationError("path is required.");
  }
  const path = assertScopedPath(ctx.scope, "write", rawPath);
  if (basename(path) === "") {
    throw validationError("path must name a file, not a directory.");
  }
  const occupied = await ctx.db.files.getByPath(path);
  if (occupied !== null) {
    throw new ApiError("CONFLICT", "A file already exists at that path.", { details: { path } });
  }
  return path;
}

/**
 * POST /v1/files/:id/move
 *
 * Pure metadata: zero R2 operations, because the object key is derived from the
 * file ID and the ID does not change (12.1). Renaming a 5 GB file costs one
 * UPDATE.
 *
 * 13's table requires write scope on BOTH source and destination - otherwise a
 * key scoped to /a could move a file it may write into /b, which is a way to
 * write outside your scope using a file you legitimately control.
 */
export async function moveFile(ctx: AuthContext, request: Request, fileId: string): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw validationError("Request body must be JSON.");
  }
  const body = raw as { path?: unknown };

  const row = await ctx.db.files.getById(fileId);
  if (row === null) throw new ApiError("NOT_FOUND", "No such file.");
  assertScope(ctx.scope, "write", row.path);

  const destination = await destinationFor(ctx, body.path);
  const folderId = await folderIdForPath(ctx, destination);

  const moved = await ctx.db.files.move(fileId, destination, basename(destination), folderId, ctx.now);
  if (!moved) {
    throw new ApiError("CONFLICT", "That file could not be moved.");
  }

  return json({
    file: {
      id: fileId,
      path: destination,
      name: basename(destination),
      previousPath: row.path,
    },
  });
}

/**
 * POST /v1/files/:id/copy
 *
 * A real copy: a new file ID means a new object key, so the bytes are actually
 * duplicated in R2 rather than two rows pointing at one object. Sharing the
 * object would make deleting either copy destroy both, which is not what
 * "copy" means to anyone.
 *
 * Read scope on the source, write scope on the destination (13's table).
 */
export async function copyFile(ctx: AuthContext, request: Request, fileId: string): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw validationError("Request body must be JSON.");
  }
  const body = raw as { path?: unknown };

  const row = await ctx.db.files.getById(fileId);
  if (row === null) throw new ApiError("NOT_FOUND", "No such file.");
  assertScope(ctx.scope, "read", row.path);

  if (row.status !== "active") {
    throw new ApiError("CONFLICT", `This file is ${row.status} and has no bytes to copy.`);
  }

  const destination = await destinationFor(ctx, body.path);

  // Quota is charged for the copy, because it really is another copy of the
  // bytes. Checked before anything is written.
  assertWithinQuota(ctx.workspace, ctx.limits, { bytes: row.size_bytes, files: 1 }, ctx.now);

  const newFileId = newId("file", ctx.now);
  await ctx.storage.copy(fileId, newFileId);

  const copied = {
    ...row,
    id: newFileId,
    folder_id: await folderIdForPath(ctx, destination),
    name: basename(destination),
    path: destination,
    r2_object_key: ctx.storage.objectKeyFor(newFileId),
    status: "active" as const,
    created_by: ctx.identity.actorId,
    created_at: ctx.now,
    updated_at: ctx.now,
  };
  await ctx.db.files.insert(copied);
  await ctx.db.counters.apply({ bytes: row.size_bytes, files: 1 }, ctx.now);

  return json({ file: { id: newFileId, path: destination, name: copied.name, sizeBytes: row.size_bytes } }, 201);
}

async function folderIdForPath(ctx: AuthContext, path: string): Promise<string | null> {
  const parent = dirname(path);
  if (parent === "/") return null;
  const folder = await ctx.db.folders.getByPath(parent);
  return folder?.id ?? null;
}
