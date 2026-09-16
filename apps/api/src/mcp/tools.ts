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
 */

import type { AuthContext, Handler } from "../middleware/auth";
import type { ScopeOp } from "../auth/scopes";
import {
  createFile,
  deleteFile as deleteFileHandler,
  getFile,
  listFiles,
  patchFile,
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

export const TOOLS: ToolDefinition[] = [
  {
    name: "list_files",
    description:
      "List files and folders under a path in the current workspace, with pagination.",
    op: "list",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder path to list. Defaults to the workspace root." },
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
      "Search files by name or path substring in the current workspace. Results are always " +
      "restricted to the paths this key may read, whatever the query matches.",
    op: "list",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match against name and path." },
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
    name: "get_file",
    description: "Get a file's metadata together with a short-lived download URL.",
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
      "Get a file's metadata without issuing a download URL. Cheaper than get_file for an " +
      "agent that needs to reason about a file rather than read it, and it does not count " +
      "against the egress allowance.",
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
      "Create a file. Pass base64 `content` for anything up to 1 MB; for larger files pass " +
      "`sizeBytes` instead and a presigned upload URL is returned.",
    op: "write",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        mimeType: { type: "string" },
        content: { type: "string", description: "Base64 bytes, 1 MB maximum." },
        sizeBytes: { type: "integer", description: "For a presigned upload instead of inline content." },
        caption: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["path"],
    },
    run: (ctx, args) => viaHandler(ctx, createFile, jsonRequest("POST", "/v1/files", args)),
  },

  {
    name: "update_file",
    description:
      "Update a file's caption, tags or metadata. This does not change its contents — " +
      "replace those with create_file.",
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
    description: "Delete a file. This is a soft delete and stays recoverable for 24 hours.",
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
    description: "Create a folder, including any missing parent folders along the way.",
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
    description: "Move or rename a file. Write access is required at both the source and the destination.",
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
      "Copy a file to a new path. The bytes are copied inside storage and never travel " +
      "through the client.",
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
