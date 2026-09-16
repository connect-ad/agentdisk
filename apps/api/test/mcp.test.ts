/**
 * The MCP server — 05 PART 14.2/14.3/14.4.
 *
 * The case this file exists for is scope filtering. 14.3 says an agent should
 * never even see a tool its key cannot call, and the failure mode if that is
 * wrong is quiet: a read-only agent discovers `delete_file`, calls it, is
 * refused, and spends its context retrying something that will never work —
 * while a prompt injection now has a named target to aim at.
 *
 * The rest is about the two surfaces staying honest with each other. Every tool
 * here runs the same handler the REST route does, so anything a REST call
 * refuses a tool call must refuse too, for the same reason and with the same
 * code.
 */

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { WORKSPACE_A, WORKSPACE_B, seedApiKey, seedTwoWorkspaces } from "./helpers";

const MCP_URL = "https://mcp-dev.agentdisk.io/mcp";

let nextId = 1;

async function rpc(
  method: string,
  params?: Record<string, unknown>,
  token?: string
): Promise<Record<string, unknown>> {
  const res = await SELF.fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return (await res.json()) as Record<string, unknown>;
}

function toolNames(response: Record<string, unknown>): string[] {
  const result = response.result as { tools?: { name: string }[] } | undefined;
  return (result?.tools ?? []).map(t => t.name).sort();
}

/** Tool results carry their payload as JSON inside a text block. */
function payloadOf(response: Record<string, unknown>): Record<string, unknown> {
  const result = response.result as { structuredContent?: Record<string, unknown> };
  return result?.structuredContent ?? {};
}

function isError(response: Record<string, unknown>): boolean {
  return (response.result as { isError?: boolean } | undefined)?.isError === true;
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  for (const table of ["audit_events", "files", "folders", "api_keys", "agents"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("protocol", () => {
  it("negotiates without a credential", async () => {
    // A client has to be able to initialize before it knows whether its key
    // works, and this reveals nothing about any workspace.
    const res = await rpc("initialize", { protocolVersion: "2025-06-18" });
    const result = res.result as { serverInfo: { name: string }; protocolVersion: string };
    expect(result.serverInfo.name).toBe("agentdisk");
    expect(result.protocolVersion).toBe("2025-06-18");
  });

  it("answers ping", async () => {
    expect((await rpc("ping")).result).toEqual({});
  });

  it("rejects a body that is not JSON-RPC 2.0", async () => {
    const res = await SELF.fetch(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "tools/list" }),
    });
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });

  it("reports an unknown method rather than guessing", async () => {
    const res = await rpc("tools/summon");
    expect((res.error as { code: number }).code).toBe(-32601);
  });

  it("refuses anything but POST", async () => {
    const res = await SELF.fetch(MCP_URL, { method: "GET" });
    expect(res.status).toBe(405);
  });
});

describe("tools/list is filtered by scope", () => {
  it("shows a read-only key only the tools it can call", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "list"] });
    const names = toolNames(await rpc("tools/list", {}, token));

    expect(names).toContain("list_files");
    expect(names).toContain("get_file");
    // Never offered. An agent that cannot see a tool cannot waste its context
    // retrying it, and an injection has nothing to name.
    expect(names).not.toContain("create_file");
    expect(names).not.toContain("delete_file");
    expect(names).not.toContain("move_file");
  });

  it("shows a writer the write tools but not delete", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "list", "write"] });
    const names = toolNames(await rpc("tools/list", {}, token));

    expect(names).toContain("create_file");
    expect(names).toContain("move_file");
    expect(names).not.toContain("delete_file");
  });

  it("shows a full key everything", async () => {
    const { token } = await seedApiKey({
      workspaceId: WORKSPACE_A,
      ops: ["read", "list", "write", "delete"],
    });
    const names = toolNames(await rpc("tools/list", {}, token));
    expect(names).toHaveLength(10);
  });

  it("needs a credential at all", async () => {
    const res = await rpc("tools/list", {});
    expect(res.error).toBeDefined();
  });

  it("never exposes workspace or key management as a tool", async () => {
    // 14.4's closing note. Letting a model mint its own credentials or delete a
    // workspace is a categorically larger blast radius than managing files
    // inside a scope a human already granted.
    const { token } = await seedApiKey({
      workspaceId: WORKSPACE_A,
      ops: ["read", "list", "write", "delete", "keys:create"],
    });
    const names = toolNames(await rpc("tools/list", {}, token));
    for (const forbidden of ["create_key", "create_workspace", "delete_workspace", "create_agent"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe("tools/call", () => {
  it("creates and lists a file", async () => {
    const { token } = await seedApiKey({
      workspaceId: WORKSPACE_A,
      ops: ["read", "list", "write"],
    });

    const created = await rpc(
      "tools/call",
      {
        name: "create_file",
        arguments: {
          path: "/mcp/hello.txt",
          mimeType: "text/plain",
          content: btoa("written by an agent"),
        },
      },
      token
    );
    expect(isError(created)).toBe(false);
    expect((payloadOf(created).file as { path: string }).path).toBe("/mcp/hello.txt");

    const listed = await rpc("tools/call", { name: "list_files", arguments: {} }, token);
    const files = payloadOf(listed).files as { path: string }[];
    expect(files.map(f => f.path)).toContain("/mcp/hello.txt");
  });

  it("refuses a tool the key's scope does not cover, even called directly", async () => {
    // Hiding it from tools/list is a convenience. This is the actual boundary.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "list"] });
    const res = await rpc(
      "tools/call",
      { name: "create_file", arguments: { path: "/nope.txt", mimeType: "text/plain", content: btoa("x") } },
      token
    );
    expect(res.error ?? isError(res)).toBeTruthy();
  });

  it("honours a path-prefix scope exactly as REST does", async () => {
    const { token } = await seedApiKey({
      workspaceId: WORKSPACE_A,
      ops: ["read", "list", "write"],
      pathPrefix: "/agents/bot",
    });

    const inside = await rpc(
      "tools/call",
      { name: "create_file", arguments: { path: "/agents/bot/ok.txt", mimeType: "text/plain", content: btoa("ok") } },
      token
    );
    expect(isError(inside)).toBe(false);

    const outside = await rpc(
      "tools/call",
      { name: "create_file", arguments: { path: "/elsewhere/no.txt", mimeType: "text/plain", content: btoa("no") } },
      token
    );
    expect(isError(outside)).toBe(true);
  });

  it("cannot reach another workspace's files", async () => {
    const mine = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "list", "write"] });
    const theirs = await seedApiKey({ workspaceId: WORKSPACE_B, ops: ["read", "list", "write"] });

    await rpc(
      "tools/call",
      { name: "create_file", arguments: { path: "/theirs.txt", mimeType: "text/plain", content: btoa("theirs") } },
      theirs.token
    );

    const listed = await rpc("tools/call", { name: "list_files", arguments: {} }, mine.token);
    expect(payloadOf(listed).files).toHaveLength(0);
  });

  it("reports a refusal as a tool error, not a protocol error", async () => {
    // The distinction a model needs: "the tool ran and said no" is actionable,
    // "your request was malformed" is not.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "list"] });
    const res = await rpc("tools/call", { name: "get_file", arguments: { id: "fil_NOTHERE" } }, token);

    expect(res.error).toBeUndefined();
    expect(isError(res)).toBe(true);
  });

  it("reports a bad credential as a protocol error", async () => {
    // And this one is not actionable by the model, so it must not look like a
    // tool refusing.
    const res = await rpc("tools/call", { name: "list_files", arguments: {} }, "ask_live_nonsense");
    expect(res.error).toBeDefined();
  });

  it("rejects an unknown tool name", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "list"] });
    const res = await rpc("tools/call", { name: "rm_rf_slash", arguments: {} }, token);
    expect((res.error as { code: number }).code).toBe(-32601);
  });
});

describe("audit", () => {
  it("records the tool called, and never its arguments", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "list", "write"] });
    const secretish = btoa("contents that must not be logged");

    await rpc(
      "tools/call",
      { name: "create_file", arguments: { path: "/audited.txt", mimeType: "text/plain", content: secretish } },
      token
    );

    const rows = await env.DB.prepare(
      `SELECT action, metadata FROM audit_events WHERE workspace_id = ?`
    ).bind(WORKSPACE_A).all<{ action: string; metadata: string | null }>();

    const actions = (rows.results ?? []).map(r => r.action);
    expect(actions).toContain("mcp.create_file");
    // A create_file call carries base64 file content in its arguments.
    expect(JSON.stringify(rows.results)).not.toContain(secretish);
  });
});
