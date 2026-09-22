/**
 * Deleting an agent deletes it — migration 0023.
 *
 * The case that matters is the one that was broken: delete "agent01", create
 * "agent01" again. The soft delete kept the row, UNIQUE(workspace_id, name)
 * kept counting it, and the second create answered "already exists" for an
 * agent nobody could see. The product's rule is that delete means gone.
 */

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { WORKSPACE_A, bearer, seedApiKey, seedTwoWorkspaces } from "./helpers";

const URL_BASE = "https://api-dev.agentdisk.io";

async function reset(): Promise<void> {
  await seedTwoWorkspaces();
  await env.DB.prepare(`DELETE FROM api_keys`).run();
  await env.DB.prepare(`DELETE FROM agents`).run();
  await env.DB.prepare(`DELETE FROM audit_events`).run();
}

function post(path: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(reset);

describe("DELETE /v1/agents/:id", () => {
  it("removes the row, so the name can be used again", async () => {
    const { token } = await seedApiKey({
      workspaceId: WORKSPACE_A,
      ops: ["read", "write", "list", "delete", "keys:create"],
    });

    const first = await post("/v1/agents", token, { name: "agent01" });
    expect(first.status).toBe(201);
    const { agent } = (await first.json()) as { agent: { id: string } };

    // A key under it, to prove the cascade still runs first.
    const minted = await post("/v1/keys", token, { name: "k", agentId: agent.id, ops: ["read"] });
    expect(minted.status).toBe(201);

    const deleted = await SELF.fetch(`${URL_BASE}/v1/agents/${agent.id}`, {
      method: "DELETE",
      headers: bearer(token),
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ deleted: true, keysDeleted: 1 });

    // Gone, not marked. This is the assertion the soft delete failed.
    const row = await env.DB.prepare(`SELECT id, status FROM agents WHERE id = ?`).bind(agent.id).first();
    expect(row).toBeNull();
    const keys = await env.DB.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE agent_id = ?`)
      .bind(agent.id)
      .first<{ n: number }>();
    expect(keys?.n).toBe(0);

    const again = await post("/v1/agents", token, { name: "agent01" });
    expect(again.status).toBe(201);
    const second = (await again.json()) as { agent: { id: string } };
    expect(second.agent.id).not.toBe(agent.id);

    // The name survives in the audit trail, which is the only place it needs to.
    const audit = await env.DB.prepare(
      `SELECT metadata FROM audit_events WHERE action = 'agent.deleted' AND resource_id = ?`
    )
      .bind(agent.id)
      .first<{ metadata: string }>();
    expect(audit?.metadata).toContain("agent01");
  });

  it("is a 404 the second time", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "write", "list", "delete"] });
    const created = await post("/v1/agents", token, { name: "once" });
    const { agent } = (await created.json()) as { agent: { id: string } };

    const del = () => SELF.fetch(`${URL_BASE}/v1/agents/${agent.id}`, { method: "DELETE", headers: bearer(token) });
    expect((await del()).status).toBe(200);
    expect((await del()).status).toBe(404);
  });
});
