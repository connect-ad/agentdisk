/**
 * File endpoints - 05 PART 12.2 (upload), 12.3 (download), 12.5 (deletion),
 * 12.6 (restore), listed in PART 13's table.
 *
 * The shape of the upload flow is the whole point and worth stating plainly:
 * the Worker is never in the byte path. It authorizes, it books, and it hands
 * back a URL scoped to exactly one object. Bytes go client -> R2 directly. The
 * one exception is the inline path for files at or below 1 MB (10.4), where the
 * round trip costs more than the write.
 *
 * Two rules run through every handler here:
 *
 *   - The client's `path` is metadata. It is validated and scope-checked, but
 *     it never reaches the R2 key, which is built from server-generated IDs
 *     alone (12.1). A traversal string can dirty a listing; it cannot escape a
 *     tenant prefix.
 *   - Sizes are never taken on trust. The client declares one to get a quota
 *     decision up front, and `complete` re-derives the real one from R2 and
 *     re-checks quota against that. A client that lies gets its bytes deleted,
 *     not its quota mis-booked.
 */

import { z } from "zod";
import { ApiError, validationError } from "../lib/errors";
import { basename, dirname, normalizePath } from "../lib/paths";
import { assertFileSizeAllowed, assertWithinQuota } from "../lib/quota";
import { assertScope, assertScopedPath, scopeAllowsPath } from "../auth/scopes";
import { newId } from "../lib/ids";
import { MAX_INLINE_BYTES } from "../storage/workspace-scoped";
import { DOWNLOAD_URL_TTL_SECONDS, UPLOAD_URL_TTL_SECONDS, redactPresigned } from "../storage/presign";
import type { AuthContext } from "../middleware/auth";
import type { FileRow } from "../db/types";
import { auditAndNotify } from "../lib/audit";

/** PART 13: "default 50, max 200". */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** 12.5: the soft-delete grace period a restore must fall inside (12.6). */
export const RESTORE_GRACE_MS = 24 * 60 * 60 * 1000;

const HEX_SHA256 = /^[0-9a-f]{64}$/;

const MetadataSchema = z.record(z.string().max(64), z.string().max(1024)).optional();

const TagsSchema = z
  .array(z.string().trim().min(1).max(64))
  .max(32)
  .optional();

const CreateSchema = z
  .object({
    path: z.string().min(1, "path is required"),
    mimeType: z.string().trim().min(1).max(255).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    // Lowercase hex, because that is the one form we can compare without
    // normalizing, and R2 expects it on the way in.
    checksumSha256: z.string().regex(HEX_SHA256, "checksumSha256 must be lowercase hex").optional(),
    /** Base64 bytes for the inline path (10.4). Mutually exclusive with sizeBytes. */
    content: z.string().optional(),
    caption: z.string().trim().max(1024).optional(),
    metadata: MetadataSchema,
    tags: TagsSchema,
  })
  .refine((body) => body.content !== undefined || body.sizeBytes !== undefined, {
    message: "either content (inline) or sizeBytes (presigned upload) is required",
  });

const CompleteSchema = z.object({
  /**
   * What the client believes it uploaded. Advisory: R2 is asked directly and
   * its answer wins. Accepted because a mismatch is worth reporting back.
   */
  sizeBytes: z.number().int().nonnegative().optional(),
  checksumSha256: z.string().regex(HEX_SHA256, "checksumSha256 must be lowercase hex").optional(),
});

const PatchSchema = z.object({
  caption: z.string().trim().max(1024).nullable().optional(),
  metadata: MetadataSchema,
  tags: TagsSchema,
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw validationError(parsed.error.issues[0]?.message ?? "Invalid request body.", {
      // Field paths only, never values: a body here can carry file content.
      fields: parsed.error.issues.map((issue) => issue.path.join(".")),
    });
  }
  return parsed.data;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw validationError("Request body must be JSON.");
  }
}

/**
 * Decode inline base64 strictly.
 *
 * `atob` is lenient about some malformed input, so the alphabet is checked
 * first. A body that is not really base64 must be a 400 rather than silently
 * becoming different bytes than the caller intended - the checksum they
 * declared would then fail against bytes they never sent.
 */
function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw validationError("content must be base64.");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw validationError("content must be base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface FileResource {
  id: string;
  workspaceId: string;
  path: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  checksumSha256: string | null;
  caption: string | null;
  metadata: Record<string, string> | null;
  tags: string[];
  status: FileRow["status"];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The wire shape. Deliberately built field by field rather than by spreading
 * the row: `r2_object_key` is in that row, and a spread would publish the
 * internal storage layout the moment someone adds a column.
 */
export function toFileResource(row: FileRow, tags: string[] = []): FileResource {
  let metadata: Record<string, string> | null = null;
  if (row.custom_metadata !== null) {
    try {
      metadata = JSON.parse(row.custom_metadata) as Record<string, string>;
    } catch {
      // Stored metadata that will not parse is a bug on the write side, not
      // something to fail a read over. Report null and move on.
      metadata = null;
    }
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    name: row.name,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    checksumSha256: row.checksum_sha256,
    caption: row.caption,
    metadata,
    tags,
    status: row.status,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Fetch a file the caller is allowed to see, or throw the right error. */
async function requireFile(ctx: AuthContext, id: string, op: "read" | "write" | "delete"): Promise<FileRow> {
  const row = await ctx.db.files.getById(id);
  if (row === null) {
    // Also the answer when the ID belongs to another workspace: the repository
    // is scoped, so that row is simply not visible. "Not found" is the truthful
    // answer and it declines to confirm the ID exists somewhere else.
    throw new ApiError("NOT_FOUND", "No such file.");
  }
  assertScope(ctx.scope, op, row.path);
  return row;
}

/** Folders are optional; a file may live at a path with no folder row. */
async function folderIdFor(ctx: AuthContext, path: string): Promise<string | null> {
  const parent = dirname(path);
  if (parent === "/") return null;
  const folder = await ctx.db.folders.getByPath(parent);
  return folder?.id ?? null;
}

/**
 * POST /v1/files - 12.2 steps 1-3.
 *
 * Creates the pending row and hands back either the finished object (inline) or
 * a presigned PUT scoped to exactly this file's key.
 */
export async function createFile(ctx: AuthContext, request: Request): Promise<Response> {
  const body = parseBody(CreateSchema, await readJson(request));

  if (body.content !== undefined && body.sizeBytes !== undefined) {
    throw validationError("Send either content or sizeBytes, not both.");
  }

  // Validation and authorization of the path happen together so neither can be
  // done without the other.
  const path = assertScopedPath(ctx.scope, "write", body.path);
  const name = basename(path);
  if (name === "") {
    throw validationError("path must name a file, not a directory.");
  }

  // UNIQUE(workspace_id, path) would catch this too, but as a 500-shaped
  // constraint violation. A 409 that says which path is a better answer.
  const existing = await ctx.db.files.getByPath(path);
  if (existing !== null) {
    throw new ApiError("CONFLICT", "A file already exists at that path.", {
      details: { path },
    });
  }

  const inline = body.content === undefined ? null : decodeBase64(body.content);
  if (inline !== null && inline.byteLength > MAX_INLINE_BYTES) {
    throw new ApiError(
      "PAYLOAD_TOO_LARGE",
      `Inline content is capped at ${MAX_INLINE_BYTES} bytes; request a presigned upload instead.`,
      { details: { limit: "storage", used: inline.byteLength, max: MAX_INLINE_BYTES } }
    );
  }

  const declaredSize = inline !== null ? inline.byteLength : (body.sizeBytes as number);
  assertFileSizeAllowed(declaredSize, ctx.limits);
  assertWithinQuota(ctx.workspace, ctx.limits, { bytes: declaredSize, files: 1 }, ctx.now);

  const fileId = newId("file", ctx.now);
  const row: FileRow = {
    id: fileId,
    workspace_id: ctx.workspaceId,
    folder_id: await folderIdFor(ctx, path),
    name,
    path,
    r2_object_key: ctx.storage.objectKeyFor(fileId),
    // Zero until the bytes are real. Believing the declared size here would let
    // a client inflate its own usage figures without uploading anything.
    size_bytes: inline !== null ? inline.byteLength : 0,
    mime_type: body.mimeType ?? "application/octet-stream",
    checksum_sha256: body.checksumSha256 ?? null,
    caption: body.caption ?? null,
    custom_metadata: body.metadata === undefined ? null : JSON.stringify(body.metadata),
    status: "pending",
    created_by: ctx.identity.actorId,
    created_at: ctx.now,
    updated_at: ctx.now,
    deleted_at: null,
  };

  await ctx.db.files.insert(row);
  if (body.tags !== undefined && body.tags.length > 0) {
    await ctx.db.files.setTags(fileId, body.tags);
  }
  const tags = body.tags ?? [];

  if (inline === null) {
    const uploadUrl = await ctx.storage.uploadUrl(fileId);
    // The URL's signature IS the capability, so only its redacted form is ever
    // logged (16.18).
    console.log(
      JSON.stringify({
        level: "info",
        requestId: ctx.requestId,
        message: "issued presigned upload",
        fileId,
        workspaceId: ctx.workspaceId,
        url: redactPresigned(uploadUrl),
      })
    );
    return json(
      {
        file: toFileResource(row, tags),
        upload: {
          method: "PUT",
          url: uploadUrl,
          headers: { "content-type": row.mime_type },
          expiresAt: new Date(ctx.now + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
        },
        next: `POST /v1/files/${fileId}/complete once the PUT succeeds`,
      },
      201
    );
  }

  // Inline path. R2 verifies the checksum itself when one was declared, so a
  // body that does not match is refused by storage rather than by a comparison
  // we would have to remember to write.
  await ctx.storage.put(fileId, inline.buffer as ArrayBuffer, {
    contentType: row.mime_type,
    sha256: body.checksumSha256,
  });

  const activated = await ctx.db.files.markActive(fileId, inline.byteLength, row.checksum_sha256, ctx.now);
  if (!activated) {
    throw new ApiError("INTERNAL_ERROR", "Something went wrong on our end.", {
      internalReason: `inline upload ${fileId} could not be flipped from pending`,
    });
  }
  await ctx.db.counters.apply({ bytes: inline.byteLength, files: 1 }, ctx.now);

  auditAndNotify(ctx, request, "file.created", {
    resourceType: "file",
    resourceId: fileId,
    metadata: { path: row.path, sizeBytes: inline.byteLength, mode: "inline" },
    // What a customer's endpoint receives. Deliberately the same shape as the
    // API's own file resource, minus anything a webhook has no business
    // carrying - no download URL, no checksum of content we never read.
    webhookData: { id: fileId, path: row.path, sizeBytes: inline.byteLength },
  });

  return json({ file: toFileResource({ ...row, status: "active" }, tags) }, 201);
}

/**
 * POST /v1/files/:id/complete - 12.2 steps 5-6.
 *
 * The size that gets booked comes from R2, not from the request. That is the
 * whole job of this endpoint: until now every number has been a claim.
 */
export async function completeFile(ctx: AuthContext, request: Request, fileId: string): Promise<Response> {
  const body = parseBody(CompleteSchema, await readJson(request));
  const row = await requireFile(ctx, fileId, "write");

  if (row.status !== "pending") {
    throw new ApiError("CONFLICT", `This file is already ${row.status}.`, {
      details: { status: row.status },
    });
  }

  const head = await ctx.storage.head(fileId);
  if (head === null) {
    throw new ApiError("CONFLICT", "No bytes have been uploaded for this file yet.");
  }

  // Re-check against what is actually stored. A client that declared 1 KB and
  // uploaded 1 GB is caught here, and the bytes are removed rather than left
  // orphaned in the bucket consuming storage nobody is accounting for.
  try {
    assertFileSizeAllowed(head.size, ctx.limits);
    assertWithinQuota(ctx.workspace, ctx.limits, { bytes: head.size, files: 1 }, ctx.now);
  } catch (err) {
    await ctx.storage.delete(fileId);
    await ctx.db.files.markFailed(fileId, ctx.now);
    console.log(
      JSON.stringify({
        level: "warn",
        requestId: ctx.requestId,
        message: "upload discarded: actual size exceeds what the workspace may store",
        fileId,
        workspaceId: ctx.workspaceId,
        declaredBytes: body.sizeBytes ?? null,
        actualBytes: head.size,
      })
    );
    throw err;
  }

  const checksum = body.checksumSha256 ?? row.checksum_sha256;
  const activated = await ctx.db.files.markActive(fileId, head.size, checksum, ctx.now);
  auditAndNotify(ctx, request, "file.created", {
    resourceType: "file",
    resourceId: fileId,
    metadata: { path: row.path, sizeBytes: head.size, mode: "presigned" },
    webhookData: { id: fileId, path: row.path, sizeBytes: head.size },
  });
  if (!activated) {
    // Lost a race with a concurrent complete. The other one won and did the
    // bookkeeping; double-counting the quota here would be worse than a 409.
    throw new ApiError("CONFLICT", "This file was completed by another request.");
  }

  await ctx.db.counters.apply({ bytes: head.size, files: 1 }, ctx.now);

  const tags = await ctx.db.files.getTags(fileId);
  const finished: FileRow = {
    ...row,
    status: "active",
    size_bytes: head.size,
    checksum_sha256: checksum,
    updated_at: ctx.now,
  };
  const resource = toFileResource(finished, tags);

  return json({
    file: resource,
    ...(body.sizeBytes !== undefined && body.sizeBytes !== head.size
      ? { notice: `Declared ${body.sizeBytes} bytes; stored ${head.size}. The stored size was used.` }
      : {}),
  });
}

/**
 * GET /v1/search - 10.5 level 1.
 *
 * Name, path, caption and tag. Not file contents: that needs an index this
 * product does not build yet, and pretending otherwise would return confidently
 * empty results for a query somebody had every reason to expect matches for.
 *
 * The scope prefix is applied inside the same statement as the match, not as a
 * filter afterwards. Filtering afterwards is how a search leaks the existence
 * of files outside a caller's scope - the count, the pagination, and the timing
 * all still carry information even when the rows are dropped.
 */
export async function searchFiles(ctx: AuthContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const term = (url.searchParams.get("q") ?? "").trim();
  if (term === "") {
    throw validationError("A search needs a q parameter.");
  }

  const rawLimit = url.searchParams.get("limit");
  let limit = DEFAULT_PAGE_SIZE;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
      throw validationError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
    }
    limit = parsed;
  }

  // Searching is a listing, and a key that may not enumerate must not be able
  // to enumerate one query at a time.
  assertScope(ctx.scope, "list");
  const cursor = url.searchParams.get("cursor");

  const rows = await ctx.db.files.search(ctx.scope.pathPrefix, term, limit + 1, cursor);
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (page[page.length - 1]?.id ?? null) : null;

  return json({
    files: page.map((row) => toFileResource(row)),
    nextCursor,
    // Named so a caller does not assume contents were searched and conclude
    // from an empty result that a file does not exist.
    searchedFields: ["name", "path", "caption", "tags"],
  });
}

/** GET /v1/files/:id */
export async function getFile(ctx: AuthContext, _request: Request, fileId: string): Promise<Response> {
  const row = await requireFile(ctx, fileId, "read");
  const tags = await ctx.db.files.getTags(fileId);
  return json({ file: toFileResource(row, tags) });
}

/**
 * The prefix a listing actually runs against.
 *
 * 10.4 requires the scope filter to be a SQL clause, never an application-level
 * filter over a wider result set - so the two prefixes are reconciled into one
 * before the query, and the narrower always wins:
 *
 *   - request inside scope  -> the request's prefix
 *   - request wider than scope -> the scope's prefix (narrowed, not refused:
 *     asking for "everything I can see" is a normal thing to do)
 *   - disjoint -> 403, because the caller asked for something specific that
 *     they may not have
 */
export function effectiveListPrefix(scopePrefix: string, requested: string | null): string {
  const scope = { ops: [], pathPrefix: scopePrefix } as unknown as Parameters<typeof scopeAllowsPath>[0];
  if (requested === null || requested === "/") {
    return scopePrefix === "" ? "/" : scopePrefix;
  }
  if (scopeAllowsPath(scope, requested)) return requested;

  const requestedAsScope = { ops: [], pathPrefix: requested } as unknown as Parameters<typeof scopeAllowsPath>[0];
  if (scopePrefix !== "" && scopeAllowsPath(requestedAsScope, scopePrefix)) return scopePrefix;

  throw new ApiError("FORBIDDEN", "This key isn't allowed to list that path.", {
    details: { pathPrefix: scopePrefix === "" ? "/*" : `${scopePrefix}/*` },
  });
}

/** GET /v1/files?path=&cursor=&limit= */
export async function listFiles(ctx: AuthContext, request: Request): Promise<Response> {
  const url = new URL(request.url);

  const rawLimit = url.searchParams.get("limit");
  let limit = DEFAULT_PAGE_SIZE;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
      throw validationError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
    }
    limit = parsed;
  }

  assertScope(ctx.scope, "list");

  const rawPath = url.searchParams.get("path");
  let requested: string | null = null;
  if (rawPath !== null) {
    // Normalized through the same validator as a write, so a traversal string
    // cannot reach the LIKE pattern. Only normalized here, NOT scope-asserted:
    // for a listing, a request wider than the key's scope is a normal thing to
    // make and gets narrowed rather than refused. Asserting the raw path first
    // would 403 it before effectiveListPrefix ever saw it, making the narrowing
    // below unreachable - which is exactly what a mutation test found.
    try {
      requested = normalizePath(rawPath);
    } catch (err) {
      throw new ApiError("VALIDATION_ERROR", err instanceof Error ? err.message : "Invalid path.");
    }
  }

  const prefix = effectiveListPrefix(ctx.scope.pathPrefix, requested);
  const cursor = url.searchParams.get("cursor");

  const rows = await ctx.db.files.listPage(prefix, limit, cursor);
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (page[page.length - 1]?.id ?? null) : null;

  return json({
    files: page.map((row) => toFileResource(row)),
    nextCursor,
  });
}

/**
 * GET /v1/files/:id/download - 12.3.
 *
 * Egress is accounted at URL generation, not at fetch: R2 does not call back on
 * a GET, so this is the only moment the Worker can see. 19's assumptions record
 * it as a deliberate approximation - it over-counts a URL that is never used.
 */
export async function downloadFile(ctx: AuthContext, _request: Request, fileId: string): Promise<Response> {
  const row = await requireFile(ctx, fileId, "read");

  if (row.status !== "active") {
    throw new ApiError("CONFLICT", `This file is ${row.status} and has no bytes to download.`, {
      details: { status: row.status },
    });
  }

  assertWithinQuota(ctx.workspace, ctx.limits, { egressBytes: row.size_bytes }, ctx.now);

  const url = await ctx.storage.downloadUrl(fileId);
  await ctx.db.counters.apply({ egressBytes: row.size_bytes }, ctx.now);

  console.log(
    JSON.stringify({
      level: "info",
      requestId: ctx.requestId,
      message: "issued presigned download",
      fileId,
      workspaceId: ctx.workspaceId,
      bytes: row.size_bytes,
      url: redactPresigned(url),
    })
  );

  return json({
    url,
    method: "GET",
    expiresAt: new Date(ctx.now + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    sizeBytes: row.size_bytes,
  });
}

/** PATCH /v1/files/:id - metadata only; bytes are immutable. */
export async function patchFile(ctx: AuthContext, request: Request, fileId: string): Promise<Response> {
  const body = parseBody(PatchSchema, await readJson(request));
  const row = await requireFile(ctx, fileId, "write");

  const caption = body.caption === undefined ? row.caption : body.caption;
  const metadata =
    body.metadata === undefined ? row.custom_metadata : JSON.stringify(body.metadata);

  await ctx.db.files.updateMetadata(fileId, caption, metadata, ctx.now);
  if (body.tags !== undefined) {
    await ctx.db.files.setTags(fileId, body.tags);
  }

  const tags = await ctx.db.files.getTags(fileId);
  return json({
    file: toFileResource(
      { ...row, caption, custom_metadata: metadata, updated_at: ctx.now },
      tags
    ),
  });
}

/**
 * DELETE /v1/files/:id - 12.5.
 *
 * Soft delete only. The R2 object is purged later by the queue consumer after
 * the grace period, which is what makes 12.6's restore possible and what keeps
 * the response fast and independent of R2's own failure modes.
 */
export async function deleteFile(ctx: AuthContext, _request: Request, fileId: string): Promise<Response> {
  const row = await requireFile(ctx, fileId, "delete");

  const deleted = await ctx.db.files.softDelete(fileId, ctx.now);
  if (!deleted) {
    throw new ApiError("CONFLICT", "This file was already deleted.");
  }

  // Usage is released now, not at purge time: the customer should stop paying
  // for it the moment they delete it. Reconciliation (10.8) is what keeps the
  // counters honest if this and the purge ever disagree.
  if (row.status === "active") {
    await ctx.db.counters.apply({ bytes: -row.size_bytes, files: -1 }, ctx.now);
  }

  auditAndNotify(ctx, _request, "file.deleted", {
    resourceType: "file",
    resourceId: fileId,
    metadata: { path: row.path, sizeBytes: row.size_bytes },
    webhookData: { id: fileId, path: row.path },
  });

  return json({
    id: fileId,
    status: "deleted",
    deletedAt: new Date(ctx.now).toISOString(),
    restorableUntil: new Date(ctx.now + RESTORE_GRACE_MS).toISOString(),
  });
}

/**
 * POST /v1/files/:id/restore - 12.6.
 *
 * Requires `delete` scope rather than `write`: restoring is the inverse of
 * deleting, so it is the same capability, and PART 13's table says so.
 */
export async function restoreFile(ctx: AuthContext, _request: Request, fileId: string): Promise<Response> {
  assertScope(ctx.scope, "delete");

  const row = await ctx.db.files.getDeletedById(fileId);
  if (row === null) {
    throw new ApiError("NOT_FOUND", "No such deleted file.");
  }
  // Path scope is checked against the row, after the scoped lookup has already
  // proved the file belongs to this workspace.
  assertScope(ctx.scope, "delete", row.path);

  const deletedAt = row.deleted_at ?? 0;
  if (ctx.now - deletedAt > RESTORE_GRACE_MS) {
    throw new ApiError("CONFLICT", "The restore window for this file has passed.", {
      details: { deletedAt: new Date(deletedAt).toISOString() },
    });
  }

  // The bytes may already be gone even inside the window if a purge ran early.
  // Better to find out here than to restore a row pointing at nothing.
  const head = await ctx.storage.head(fileId);
  if (head === null) {
    throw new ApiError("CONFLICT", "This file's contents have already been purged.");
  }

  const restored = await ctx.db.files.restore(fileId, ctx.now);
  if (!restored) {
    throw new ApiError("CONFLICT", "This file is not in a restorable state.");
  }
  await ctx.db.counters.apply({ bytes: head.size, files: 1 }, ctx.now);

  const tags = await ctx.db.files.getTags(fileId);
  return json({
    file: toFileResource(
      { ...row, status: "active", deleted_at: null, size_bytes: head.size, updated_at: ctx.now },
      tags
    ),
  });
}
