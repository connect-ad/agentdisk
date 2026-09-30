/**
 * The MCP tool surface — 05 PART 14.4.
 *
 * Every tool is a thin wrapper that builds a Request and hands it to the REST
 * handler that already does the work. That indirection looks redundant and is
 * the most important decision in this file: 14.1 requires that REST and MCP can
 * never drift in what they allow, and the only way to guarantee that is for
 * them to be the same code. A second implementation "just for MCP" is how one
 * surface ends up permitting something the other refuses.
 *
 * Consequently every tool inherits the whole authorization chain unchanged —
 * scope check, path-prefix check, workspace binding, quota, billing status —
 * without a single one of them being re-stated here.
 *
 * Workspace, agent and key *management* are deliberately absent (14.4's closing
 * note). Letting a model mint its own credentials or delete a workspace is a
 * categorically larger blast radius than letting it manage files inside a scope
 * a human already granted, and nothing in the product's use cases needs it.
 *
 * **Descriptions are written for the model, not for a reference page.** A tool
 * description is the only documentation an agent reads before choosing, so
 * each one says *when* to reach for the tool and what it will not do, in that
 * order. The dashboard's docs page (`routes/Docs.jsx`) and MCP page
 * (`routes/McpConnection.jsx`) mirror this list by hand and `docs.test.jsx`
 * pins the names, so a tool added here is added there in the same change.
 */

import type { AuthContext, Handler } from "../middleware/auth";
import type { ScopeOp } from "../auth/scopes";
import { assertScopedPath } from "../auth/scopes";
import { ApiError } from "../lib/errors";
import {
  createFile,
  deleteFile as deleteFileHandler,
  getFile,
  listFiles,
  patchFile,
  readFile,
  searchFiles,
} from "../routes/files";
import { copyFile, createFolder, moveFile } from "../routes/folders";

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema, as MCP clients expect on `tools/list`. */
  inputSchema: Record<string, unknown>;
  /**
   * The scope op a key must hold. `tools/list` filters on this, so an agent
   * never sees a tool it could not call — less confusion, and less surface for
   * a prompt injection to aim at.
   */
  op: ScopeOp;
  /** Turns tool arguments into the request the REST handler expects. */
  run: (ctx: AuthContext, args: Record<string, unknown>) => Promise<unknown>;
}

const BASE = "https://mcp.agentdisk.io";

function jsonRequest(method: string, path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Run a REST handler and hand back its parsed body.
 *
 * A handler signals failure by throwing an ApiError, which propagates straight
 * out to the JSON-RPC layer — so a tool call fails with the same code and
 * message the REST caller would have seen, rather than a second vocabulary of
 * MCP-specific errors nobody has documented.
 */
async function viaHandler(
  ctx: AuthContext,
  handler: Handler,
  request: Request
): Promise<unknown> {
  const response = await handler(ctx, request);
  if (response.status === 204) return { ok: true };
  return response.json();
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Turn a tool's `id` or `path` argument into a file id.
 *
 * Agents think in paths — they wrote `/memory/tasks.md`, not `fil_01J…` — so
 * the read tool takes either. The path is validated and scope-checked here
 * with the same function the REST handlers use, then looked up through the
 * workspace-bound repository, and the handler that runs afterwards re-checks
 * scope on the row it fetches. Nothing is authorized in this file that the
 * REST surface would not authorize identically.
 */
async function resolveFileId(ctx: AuthContext, args: Record<string, unknown>): Promise<string> {
  const id = str(args, "id");
  if (id !== undefined) return id;
  const path = str(args, "path");
  if (path === undefined) throw new Error("Pass either id or path.");
  const canonical = assertScopedPath(ctx.scope, "read", path);
  const row = await ctx.db.files.getByPath(canonical);
  if (row === null) throw new ApiError("NOT_FOUND", "No such file.");
  return row.id;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "list_files",
    description:
      "List the files and folders under a path in this workspace, with pagination. Use it " +
      "to see what earlier sessions persisted, or to find the id of a file you know the " +
      "name of. Listings are clipped to the paths your key may read.",
    op: "list",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'Folder path to list, e.g. "/memory". Defaults to the workspace root.' },
        cursor: { type: "string", description: "Opaque cursor from a previous call." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
    },
    run: (ctx, args) => {
      const query = new URLSearchParams();
      const path = str(args, "path");
      if (path !== undefined) query.set("path", path);
      const cursor = str(args, "cursor");
      if (cursor !== undefined) query.set("cursor", cursor);
      if (typeof args.limit === "number") query.set("limit", String(args.limit));
      return viaHandler(ctx, listFiles, jsonRequest("GET", `/v1/files?${query.toString()}`));
    },
  },

  {
    name: "search_files",
    description:
      "Find files whose name, path, caption or tags contain a substring. Use it when you " +
      "do not know where something was saved. It does not look inside file contents; read " +
      "a candidate with read_file to check. Results never leave the paths your key may read.",
    op: "list",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match against name, path, caption and tags." },
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      required: ["query"],
    },
    run: (ctx, args) => {
      const query = new URLSearchParams();
      const q = str(args, "query");
      if (q !== undefined) query.set("q", q);
      const cursor = str(args, "cursor");
      if (cursor !== undefined) query.set("cursor", cursor);
      if (typeof args.limit === "number") query.set("limit", String(args.limit));
      return viaHandler(ctx, searchFiles, jsonRequest("GET", `/v1/search?${query.toString()}`));
    },
  },

  {
    name: "read_file",
    description:
      "Read a file's contents directly, by id or by path. Use this to read back notes, " +
      "task lists, results or anything another session or agent persisted. Text comes back " +
      'as UTF-8 in `content` (encoding "utf-8"); anything else is base64. Files over 1 MB ' +
      "cannot be read inline: call get_file for a download URL instead. Counts as egress.",
    op: "read",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The file id, from list_files or search_files." },
        path: { type: "string", description: 'The file\'s absolute path, e.g. "/memory/tasks.md". Used when id is absent.' },
      },
    },
    run: async (ctx, args) => {
      const id = await resolveFileId(ctx, args);
      return viaHandler(
        ctx,
        (c, r) => readFile(c, r, id),
        jsonRequest("GET", `/v1/files/${id}/content`)
      );
    },
  },

  {
    name: "get_file",
    description:
      "Get a file's metadata together with a short-lived download URL for its bytes. Use it " +
      "for files over 1 MB, or when a person or another system needs a link; to read text " +
      "yourself, read_file is simpler. Counts as egress whether or not the URL is used.",
    op: "read",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    run: async (ctx, args) => {
      const id = str(args, "id");
      if (id === undefined) throw new Error("id is required");
      return viaHandler(
        ctx,
        (c, r) => getFile(c, r, id),
        jsonRequest("GET", `/v1/files/${id}`)
      );
    },
  },

  {
    name: "get_metadata",
    description:
      "Get a file's size, type, checksum, caption, tags and custom metadata without its " +
      "contents. Use it to decide whether a file is worth reading, or to check it still " +
      "exists. Free: it issues no URL and counts against nothing.",
    op: "read",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    run: async (ctx, args) => {
      const id = str(args, "id");
      if (id === undefined) throw new Error("id is required");
      return viaHandler(
        ctx,
        (c, r) => getFile(c, r, id),
        jsonRequest("GET", `/v1/files/${id}`)
      );
    },
  },

  {
    name: "create_file",
    description:
      "Persist a new file. Use it for anything that must survive this session or be read " +
      "by another agent or a person: notes, task lists, results, intermediate artefacts. " +
      "Pass base64 `content` for anything up to 1 MB; for larger files pass `sizeBytes` " +
      "and upload to the presigned URL returned. The path must not already exist: to " +
      "change a file, write a new path or delete_file first, because contents are immutable.",
    op: "write",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'Absolute path, e.g. "/memory/tasks.md". Missing folders are implied.' },
        mimeType: { type: "string", description: 'e.g. "text/markdown". Defaults to application/octet-stream.' },
        content: { type: "string", description: "Base64 bytes, 1 MB maximum." },
        sizeBytes: { type: "integer", description: "For a presigned upload instead of inline content." },
        caption: { type: "string", description: "A one-line description; searchable." },
        tags: { type: "array", items: { type: "string" }, description: "Up to 32 tags; searchable." },
      },
      required: ["path"],
    },
    run: (ctx, args) => viaHandler(ctx, createFile, jsonRequest("POST", "/v1/files", args)),
  },

  {
    name: "update_file",
    description:
      "Change a file's caption, tags or custom metadata, for example to mark a result as " +
      "reviewed or to tag it for a later search. This never changes the contents; for " +
      "that, create_file at a new path or delete_file and create_file again.",
    op: "write",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        caption: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        customMetadata: { type: "object" },
      },
      required: ["id"],
    },
    run: async (ctx, args) => {
      const id = str(args, "id");
      if (id === undefined) throw new Error("id is required");
      const { id: _omit, ...body } = args;
      return viaHandler(
        ctx,
        (c, r) => patchFile(c, r, id),
        jsonRequest("PATCH", `/v1/files/${id}`, body)
      );
    },
  },

  {
    name: "delete_file",
    description:
      "Permanently delete a file. The bytes and the record are destroyed in the same call; " +
      "there is no recycle bin and no restore. Use it only when the person asked for the " +
      "deletion or the file is your own scratch data. When in doubt, leave it and say so.",
    op: "delete",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    run: async (ctx, args) => {
      const id = str(args, "id");
      if (id === undefined) throw new Error("id is required");
      return viaHandler(
        ctx,
        (c, r) => deleteFileHandler(c, r, id),
        jsonRequest("DELETE", `/v1/files/${id}`)
      );
    },
  },

  {
    name: "create_folder",
    description:
      "Create a folder, including any missing parents. Rarely needed, because a file's " +
      "path implies its folders. Use it only to set up an empty structure in advance.",
    op: "write",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    run: (ctx, args) => viaHandler(ctx, createFolder, jsonRequest("POST", "/v1/folders", args)),
  },

  {
    name: "move_file",
    description:
      "Move or rename a file to a new path, keeping its contents and tags. Use it to " +
      'archive ("/tasks/done/…") or to correct a name. Your key needs write access at ' +
      "both the old and the new path.",
    op: "write",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, newPath: { type: "string" } },
      required: ["id", "newPath"],
    },
    run: async (ctx, args) => {
      const id = str(args, "id");
      if (id === undefined) throw new Error("id is required");
      return viaHandler(
        ctx,
        (c, r) => moveFile(c, r, id),
        jsonRequest("POST", `/v1/files/${id}/move`, { newPath: args.newPath })
      );
    },
  },

  {
    name: "copy_file",
    description:
      "Copy a file to a new path inside storage; the bytes never travel through you. Use " +
      "it to snapshot a file before replacing it, or to hand a result to another agent's " +
      "folder. Needs read at the source and write at the destination.",
    op: "write",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, newPath: { type: "string" } },
      required: ["id", "newPath"],
    },
    run: async (ctx, args) => {
      const id = str(args, "id");
      if (id === undefined) throw new Error("id is required");
      return viaHandler(
        ctx,
        (c, r) => copyFile(c, r, id),
        jsonRequest("POST", `/v1/files/${id}/copy`, { newPath: args.newPath })
      );
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));
