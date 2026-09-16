/**
 * The audit trail — 05 PART 11.1, 03 §8.20.
 *
 * These exist because of a specific failure: `audit_events` and its repository
 * shipped in Phase 1 and nothing called them for months. The table was there,
 * the screen was there, and the trail was empty. A test that a row is actually
 * written is the only thing that would have caught it, so that is what most of
 * these are.
 *
 * The other half is what must *not* be in a row. 06 PART 16 forbids file
 * contents, raw keys and Authorization headers from ever reaching the log, and
 * a secret that leaks into an audit row leaks into every screen and export that
 * reads one.
 */

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { WORKSPACE_A, WORKSPACE_B, bearer, seedAgent, seedApiKey, seedTwoWorkspaces } from "./helpers";

const URL_BASE = "https://api-dev.agentdisk.io";

async function events(workspaceId = WORKSPACE_A): Promise<
  { action: string; actor_type: string; actor_id: string; result: string; metadata: string | null; resource_id: string | null }[]
> {
  const rows = await env.DB.prepare(
    `SELECT action, actor_type, actor_id, result, metadata, resource_id
       FROM audit_events WHERE workspace_id = ? ORDER BY created_at ASC, rowid ASC`
  ).bind(workspaceId).all<{
    action: string; actor_type: string; actor_id: string;
    result: string; metadata: string | null; resource_id: string | null;
  }>();
  return rows.results ?? [];
}

function post(path: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  for (const table of ["audit_events", "api_keys", "agents", "files"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("what gets recorded", () => {
  it("records an agent being created", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write", "list"] });
    await post("/v1/agents", token, { name: "recorded-bot" });

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("agent.created");
    expect(rows[0]?.result).toBe("success");
    expect(JSON.parse(rows[0]?.metadata ?? "{}")).toMatchObject({ name: "recorded-bot" });
  });

  it("records a key being minted, with its scope and never its secret", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "write", "keys:create"] });
    const res = await post("/v1/keys", token, { name: "audited", ops: ["read"] });
    const { secret } = (await res.json()) as { secret: string };

    const rows = await events();
    const created = rows.find(r => r.action === "key.created");
    expect(created).toBeDefined();

    const metadata = JSON.parse(created?.metadata ?? "{}") as Record<string, string>;
    expect(metadata.ops).toBe("read");
    // The prefix is enough to identify which key. The secret is not in the row
    // at all - an audit log that carried it would leak it into every screen and
    // export that reads one.
    expect(created?.metadata).not.toContain(secret);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it("records a key being revoked", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "keys:create"] });
    const minted = (await (await post("/v1/keys", token, { name: "doomed", ops: ["read"] })).json()) as {
      key: { id: string };
    };
    await SELF.fetch(`${URL_BASE}/v1/keys/${minted.key.id}`, { method: "DELETE", headers: bearer(token) });

    const actions = (await events()).map(r => r.action);
    expect(actions).toContain("key.revoked");
  });

  it("records an upload and a delete", async () => {
    const { token } = await seedApiKey({
      workspaceId: WORKSPACE_A,
      ops: ["read", "write", "delete", "list"],
    });
    const content = btoa("audit me");
    const created = (await (
      await post("/v1/files", token, { path: "/audited.txt", mimeType: "text/plain", content })
    ).json()) as { file: { id: string } };

    await SELF.fetch(`${URL_BASE}/v1/files/${created.file.id}`, {
      method: "DELETE",
      headers: bearer(token),
    });

    const rows = await events();
    expect(rows.map(r => r.action)).toEqual(
      expect.arrayContaining(["file.created", "file.deleted"])
    );
    const upload = rows.find(r => r.action === "file.created");
    expect(JSON.parse(upload?.metadata ?? "{}")).toMatchObject({ path: "/audited.txt", mode: "inline" });
    // Never the bytes. This is the rule 06 PART 16 states most plainly.
    expect(upload?.metadata).not.toContain(content);
  });

  it("names the agent as the actor, not the person who minted its key", async () => {
    const agentId = await seedAgent({ id: "agt_AUDIT", workspaceId: WORKSPACE_A });
    const { token } = await seedApiKey({
      workspaceId: WORKSPACE_A,
      agentId,
      ops: ["read", "write", "list"],
    });
    await post("/v1/agents", token, { name: "made-by-an-agent" });

    const row = (await events())[0];
    // The whole product thesis is that a human can see which agent did what.
    expect(row?.actor_type).toBe("agent");
    expect(row?.actor_id).toBe(agentId);
  });
});

describe("isolation", () => {
  it("writes the event into the acting workspace only", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write", "list"] });
    await post("/v1/agents", token, { name: "mine" });

    expect(await events(WORKSPACE_A)).toHaveLength(1);
    expect(await events(WORKSPACE_B)).toHaveLength(0);
  });

  it("does not show another workspace's history", async () => {
    const mine = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write", "list"] });
    const theirs = await seedApiKey({ workspaceId: WORKSPACE_B, ops: ["write", "list"] });
    await post("/v1/agents", mine.token, { name: "mine" });
    await post("/v1/agents", theirs.token, { name: "theirs" });

    const body = (await (
      await SELF.fetch(`${URL_BASE}/v1/activity`, { headers: bearer(mine.token) })
    ).json()) as { events: { metadata: Record<string, string> }[] };

    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.metadata?.name).toBe("mine");
  });
});

describe("reading it back", () => {
  it("returns newest first", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write", "list"] });
    await post("/v1/agents", token, { name: "first" });
    await post("/v1/agents", token, { name: "second" });

    const body = (await (
      await SELF.fetch(`${URL_BASE}/v1/activity`, { headers: bearer(token) })
    ).json()) as { events: { action: string; at: string }[] };

    expect(body.events.length).toBeGreaterThanOrEqual(2);
    expect(new Date(body.events[0]!.at).getTime()).toBeGreaterThanOrEqual(
      new Date(body.events[1]!.at).getTime()
    );
  });

  it("clamps an absurd limit rather than refusing it", async () => {
    // Somebody asking for a thousand rows wants as many as they can have.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list"] });
    const res = await SELF.fetch(`${URL_BASE}/v1/activity?limit=100000`, { headers: bearer(token) });
    expect(res.status).toBe(200);
    expect((await res.json()) as { limit: number }).toMatchObject({ limit: 200 });
  });

  it("rejects a limit that is not a number", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list"] });
    const res = await SELF.fetch(`${URL_BASE}/v1/activity?limit=lots`, { headers: bearer(token) });
    expect(res.status).toBe(400);
  });

  it("needs the list scope", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read"] });
    const res = await SELF.fetch(`${URL_BASE}/v1/activity`, { headers: bearer(token) });
    expect(res.status).toBe(403);
  });

  it("has no way to write one", async () => {
    // An audit trail a caller can post to is not an audit trail.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write", "list"] });
    const res = await post("/v1/activity", token, { action: "totally.legitimate" });
    expect(res.status).toBe(404);
  });
});

describe("when the audit write itself fails", () => {
  it("does not fail the request it was describing", async () => {
    // The action already happened. Refusing to acknowledge it because a second
    // INSERT failed would turn a logging problem into a data-loss report.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write", "list"] });
    await env.DB.prepare(`DROP TABLE audit_events`).run();

    const res = await post("/v1/agents", token, { name: "survives-a-broken-log" });
    expect(res.status).toBe(201);

    // Put it back for whatever runs next.
    await env.DB.prepare(
      `CREATE TABLE audit_events (
         id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
         actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
         resource_type TEXT, resource_id TEXT, result TEXT NOT NULL, ip TEXT,
         client TEXT, request_id TEXT, metadata TEXT, created_at INTEGER NOT NULL)`
    ).run();
  });
});
