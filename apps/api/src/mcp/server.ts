/**
 * The MCP server — 05 PART 14.2/14.3.
 *
 * JSON-RPC 2.0 over Streamable HTTP, inside the same Worker as REST. That
 * co-location is the architectural decision 14.2 argues for at length: one
 * authorization implementation, one deploy, one place rate limits and audit
 * logging happen, and no possibility of the two surfaces drifting apart in what
 * they permit.
 *
 * Authentication is an API key, exactly as REST. There is deliberately no
 * Firebase path here — MCP is how an *agent* connects, and a human session is
 * not something a model should be holding.
 *
 * The one MCP-specific rule worth stating: **`tools/list` is filtered by the
 * presented key's scope.** An agent handed a read-only key does not merely get
 * refused when it calls `delete_file`; it never learns the tool exists. That
 * removes a whole class of confused-model retry loop, and gives a prompt
 * injection nothing to aim at.
 */

import { withAuth, type Requirement, type WithAuthDeps } from "../middleware/auth";
import { ApiError } from "../lib/errors";
import { audit } from "../lib/audit";
import { TOOLS, TOOLS_BY_NAME } from "./tools";

/** What this server reports itself as during `initialize`. */
const SERVER_INFO = { name: "agentdisk", version: "1.0.0" };
const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC's own codes, plus the one application range it reserves. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function rpcResult(id: string | number | null, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): Response {
  // Always HTTP 200. A JSON-RPC error is a successful HTTP exchange carrying a
  // failure in its body, and clients that follow the spec read the body rather
  // than the status.
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }
  );
}

/**
 * A tool result in MCP's shape.
 *
 * The payload is JSON inside a text block, which is what nearly every client
 * renders and what a model reads most reliably. `structuredContent` carries the
 * same object for clients that prefer it, so neither kind has to parse a string
 * that was already an object.
 */
function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

/**
 * A failed tool call, reported inside the result rather than as a JSON-RPC
 * error.
 *
 * That is the MCP convention and it matters: a protocol-level error means the
 * *call* was malformed, while `isError: true` means the tool ran and refused.
 * A model can act on the second — fix the path, ask for a different file — and
 * can do nothing useful with the first.
 */
function toolFailure(message: string, code?: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: code === undefined ? message : `${code}: ${message}` }],
    isError: true,
  };
}

export interface McpDeps extends Omit<WithAuthDeps, "now"> {
  now?: number;
}

export async function handleMcp(request: Request, deps: McpDeps): Promise<Response> {
  if (request.method !== "POST") {
    // Streamable HTTP also defines GET for a server-initiated stream. Nothing
    // here pushes to the client, so advertising it would be a promise this
    // server does not keep.
    return new Response(
      JSON.stringify({ error: "This MCP endpoint accepts POST." }),
      { status: 405, headers: { "content-type": "application/json", allow: "POST" } }
    );
  }

  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, PARSE_ERROR, "Request body is not valid JSON.");
  }

  const id = body.id ?? null;
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(id, INVALID_REQUEST, "Expected a JSON-RPC 2.0 request with a method.");
  }

  switch (body.method) {
    case "initialize":
      // Unauthenticated on purpose: a client has to be able to negotiate before
      // it knows whether its credential works, and this reveals nothing about
      // the workspace behind the key.
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
      // A notification carries no id and expects no reply, but returning an
      // empty 200 keeps simple HTTP clients happy.
      return new Response(null, { status: 202 });

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return listTools(request, deps, id);

    case "tools/call":
      return callTool(request, deps, id, body.params ?? {});

    default:
      return rpcError(id, METHOD_NOT_FOUND, `Unknown method: ${body.method}`);
  }
}

/** Authenticate, then answer with only the tools this key's scope permits. */
async function listTools(
  request: Request,
  deps: McpDeps,
  id: string | number | null
): Promise<Response> {
  return authenticated(request, deps, id, { op: null }, async ctx => {
    const allowed = TOOLS.filter(tool => ctx.scope.ops.includes(tool.op));
    return rpcResult(id, {
      tools: allowed.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
  });
}

async function callTool(
  request: Request,
  deps: McpDeps,
  id: string | number | null,
  params: Record<string, unknown>
): Promise<Response> {
  const name = typeof params.name === "string" ? params.name : null;
  if (name === null) {
    return rpcError(id, INVALID_PARAMS, "tools/call requires a tool name.");
  }

  const tool = TOOLS_BY_NAME.get(name);
  if (tool === undefined) {
    return rpcError(id, METHOD_NOT_FOUND, `Unknown tool: ${name}`);
  }

  const args = (params.arguments ?? {}) as Record<string, unknown>;

  // The requirement is declared here, so the tool runs behind the same chain a
  // REST call would - including the scope check. A tool hidden from tools/list
  // is still refused if it is called directly.
  return authenticated(request, deps, id, { op: tool.op }, async ctx => {
    try {
      const payload = await tool.run(ctx, args);
      audit(ctx, request, `mcp.${name}`, {
        resourceType: "tool",
        resourceId: name,
        // Never the arguments: a create_file call carries base64 file content.
        metadata: { tool: name },
      });
      return rpcResult(id, toolResult(payload));
    } catch (err) {
      if (err instanceof ApiError) {
        audit(ctx, request, `mcp.${name}`, {
          resourceType: "tool",
          resourceId: name,
          result: "denied",
          metadata: { tool: name, code: err.code },
        });
        return rpcResult(id, toolFailure(err.message, err.code));
      }
      return rpcResult(id, toolFailure(err instanceof Error ? err.message : String(err)));
    }
  });
}

/**
 * Run something behind the full authorization chain.
 *
 * An authentication failure becomes a JSON-RPC error rather than a tool result,
 * because it is the *call* that was rejected, not the tool that refused - and a
 * client needs to distinguish "your key is wrong" from "that file does not
 * exist" to know whether retrying differently could ever help.
 */
async function authenticated(
  request: Request,
  deps: McpDeps,
  id: string | number | null,
  requirement: Requirement,
  run: (ctx: Parameters<Parameters<typeof withAuth>[3]>[0]) => Promise<Response>
): Promise<Response> {
  try {
    return await withAuth(
      request,
      { ...deps, firebase: null } as WithAuthDeps,
      requirement,
      async ctx => run(ctx)
    );
  } catch (err) {
    if (err instanceof ApiError) {
      const code = err.code === "UNAUTHORIZED" || err.code === "FORBIDDEN"
        ? INVALID_REQUEST
        : INTERNAL_ERROR;
      return rpcError(id, code, err.message, { code: err.code });
    }
    return rpcError(id, INTERNAL_ERROR, "Something went wrong on our end.");
  }
}
