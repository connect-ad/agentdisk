/**
 * Agents and API keys — 05 PART 13, 06 PART 15.3.
 *
 * The cases worth having are the ones where getting it wrong is silent. A key
 * that can mint a more powerful key looks fine in every happy-path test and
 * makes the entire scope model decorative; an agent you disabled whose keys
 * keep working looks fine too, right up until it does not.
 */

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { NOW, WORKSPACE_A, WORKSPACE_B, bearer, seedAgent, seedApiKey, seedTwoWorkspaces } from "./helpers";

const URL_BASE = "https://api-dev.agentdisk.io";

async function reset(): Promise<void> {
  await seedTwoWorkspaces();
  for (const table of ["api_keys", "agents"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

function post(path: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(reset);

describe("agents", () => {
  it("creates, lists, renames and disables", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "write", "list", "delete"] });

    const created = await post("/v1/agents", token, { name: "research-bot", description: "reads things" });
    expect(created.status).toBe(201);
    const { agent } = (await created.json()) as { agent: { id: string; status: string } };
    expect(agent.status).toBe("active");

    const listed = (await (
      await SELF.fetch(`${URL_BASE}/v1/agents`, { headers: bearer(token) })
    ).json()) as { agents: { name: string }[] };
    expect(listed.agents.map(a => a.name)).toEqual(["research-bot"]);

    const patched = await SELF.fetch(`${URL_BASE}/v1/agents/${agent.id}`, {
      method: "PATCH",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({ status: "disabled", name: "retired-bot" }),
    });
    expect(patched.status).toBe(200);
    const after = (await patched.json()) as { agent: { name: string; status: string } };
    expect(after.agent.name).toBe("retired-bot");
    expect(after.agent.status).toBe("disabled");
  });

  it("refuses a second agent with the same name", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write"] });
    expect((await post("/v1/agents", token, { name: "twin" })).status).toBe(201);
    // Two agents with one name makes every scope prefix mentioning it ambiguous.
    expect((await post("/v1/agents", token, { name: "twin" })).status).toBe(409);
  });

  it("refuses a name that could forge a scope prefix", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write"] });
    for (const name of ["bot/../admin", "with space", "/leading"]) {
      expect((await post("/v1/agents", token, { name })).status).toBe(400);
    }
  });

  it("cannot see another workspace's agents", async () => {
    await seedAgent({ id: "agt_THEIRS", workspaceId: WORKSPACE_B });
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list"] });

    const body = (await (
      await SELF.fetch(`${URL_BASE}/v1/agents`, { headers: bearer(token) })
    ).json()) as { agents: unknown[] };
    expect(body.agents).toHaveLength(0);
  });

  it("revokes an agent's keys when the agent is deleted", async () => {
    // Disabling relies on the status check at authentication. Deleting removes
    // the row that check reads, so the keys have to be revoked explicitly or
    // they would outlive the thing that was stopping them.
    const { token: adminToken } = await seedApiKey({
      workspaceId: WORKSPACE_A,
      ops: ["read", "write", "delete", "list", "keys:create"],
    });
    const agentId = await seedAgent({ id: "agt_DOOMED", workspaceId: WORKSPACE_A });
    const minted = (await (
      await post("/v1/keys", adminToken, { name: "its key", agentId, ops: ["read"] })
    ).json()) as { secret: string };

    // The key works while the agent exists.
    expect(
      (await SELF.fetch(`${URL_BASE}/v1/whoami`, { headers: bearer(minted.secret) })).status
    ).toBe(200);

    const deleted = await SELF.fetch(`${URL_BASE}/v1/agents/${agentId}`, {
      method: "DELETE",
      headers: bearer(adminToken),
    });
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as { keysRevoked: number }).keysRevoked).toBe(1);

    expect(
      (await SELF.fetch(`${URL_BASE}/v1/whoami`, { headers: bearer(minted.secret) })).status
    ).toBe(401);
  });
});

describe("minting keys", () => {
  it("returns the secret exactly once, and stores only its hash", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["keys:create", "read"] });

    const res = await post("/v1/keys", token, { name: "ci", ops: ["read"] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { secret: string; key: { id: string } };
    expect(body.secret).toMatch(/^ask_(live|test)_/);

    const stored = await env.DB.prepare(`SELECT key_hash FROM api_keys WHERE id = ?`)
      .bind(body.key.id)
      .first<{ key_hash: string }>();
    expect(stored?.key_hash).not.toContain(body.secret);

    // The list never carries it again - there is no "show key" to build later.
    const listed = await (
      await SELF.fetch(`${URL_BASE}/v1/keys`, { headers: bearer(token) })
    ).text();
    expect(listed).not.toContain(body.secret);
  });

  it("the minted key actually works", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["keys:create", "read", "list"] });
    const { secret } = (await (
      await post("/v1/keys", token, { name: "works", ops: ["read"] })
    ).json()) as { secret: string };

    const who = await SELF.fetch(`${URL_BASE}/v1/whoami`, { headers: bearer(secret) });
    expect(who.status).toBe(200);
    const body = (await who.json()) as { key: { scopes: { ops: string[] } } };
    expect(body.key.scopes.ops).toEqual(["read"]);
  });

  it("will not mint a key more powerful than the one minting it", async () => {
    // The whole point of scoping. A read-only key holding keys:create that
    // could mint a writer would make the ceiling decorative.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "keys:create"] });

    const escalate = await post("/v1/keys", token, { name: "sneaky", ops: ["read", "write"] });
    expect(escalate.status).toBe(403);

    const sameOrLess = await post("/v1/keys", token, { name: "fine", ops: ["read"] });
    expect(sameOrLess.status).toBe(201);
  });

  it("will not widen a path prefix either", async () => {
    const { token } = await seedApiKey({
      workspaceId: WORKSPACE_A,
      ops: ["read", "keys:create"],
      pathPrefix: "/agents/bot",
    });

    expect((await post("/v1/keys", token, { name: "wide", ops: ["read"], pathPrefix: "/" })).status).toBe(403);
    expect(
      (await post("/v1/keys", token, { name: "narrow", ops: ["read"], pathPrefix: "/agents/bot/logs" })).status
    ).toBe(201);
  });

  it("refuses to mint without the keys:create op", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "write", "delete", "list"] });
    expect((await post("/v1/keys", token, { name: "nope", ops: ["read"] })).status).toBe(403);
  });

  it("refuses a key for a disabled agent", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["keys:create", "read"] });
    const disabledId = await seedAgent({ id: "agt_OFF", workspaceId: WORKSPACE_A, status: "disabled" });
    // The key would be born unusable, so handing one over would be a lie.
    expect(
      (await post("/v1/keys", token, { name: "dead", agentId: disabledId, ops: ["read"] })).status
    ).toBe(400);
  });

  /**
   * The listing and the authenticator have to agree about the same key.
   *
   * They did not. `status` was computed from `revoked_at` and `expires_at`
   * alone, so a key whose agent had been disabled listed as "active" while
   * every request it made was refused — somebody disables an agent to stop it,
   * sees its credentials still shown as live, and cannot tell whether the
   * disable took effect. Both halves are asserted here together, in one test,
   * so that fixing the display without the enforcement (or the reverse) fails.
   */
  it("reports a disabled agent's key as blocked, and refuses it", async () => {
    const agentId = await seedAgent({ id: "agt_TOGGLE", workspaceId: WORKSPACE_A });
    const agentKey = await seedApiKey({ workspaceId: WORKSPACE_A, agentId, ops: ["list", "read"] });
    const lister = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list"] });

    const statusOf = async (): Promise<string | undefined> => {
      const body = (await (
        await SELF.fetch(`${URL_BASE}/v1/keys`, { headers: bearer(lister.token) })
      ).json()) as { keys: { id: string; status: string }[] };
      return body.keys.find(k => k.id === agentKey.keyId)?.status;
    };

    expect(await statusOf()).toBe("active");
    expect((await SELF.fetch(`${URL_BASE}/v1/agents`, { headers: bearer(agentKey.token) })).status).toBe(200);

    await env.DB.prepare(`UPDATE agents SET status = 'disabled' WHERE id = ?`).bind(agentId).run();

    expect(await statusOf()).toBe("blocked");
    expect((await SELF.fetch(`${URL_BASE}/v1/agents`, { headers: bearer(agentKey.token) })).status).toBe(401);

    // Reversible, and the listing has to say so: re-enabling restores the key
    // rather than requiring a new one to be minted.
    await env.DB.prepare(`UPDATE agents SET status = 'active' WHERE id = ?`).bind(agentId).run();
    expect(await statusOf()).toBe("active");
  });

  it("keeps revoked ahead of blocked, so a dead key never reads as recoverable", async () => {
    const agentId = await seedAgent({ id: "agt_GONE", workspaceId: WORKSPACE_A });
    const revoked = await seedApiKey({
      workspaceId: WORKSPACE_A,
      agentId,
      ops: ["read"],
      revokedAt: NOW - 1000,
    });
    const lister = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list"] });
    await env.DB.prepare(`UPDATE agents SET status = 'disabled' WHERE id = ?`).bind(agentId).run();

    const body = (await (
      await SELF.fetch(`${URL_BASE}/v1/keys`, { headers: bearer(lister.token) })
    ).json()) as { keys: { id: string; status: string }[] };

    // Blocked lifts when the agent comes back; revoked never does.
    expect(body.keys.find(k => k.id === revoked.keyId)?.status).toBe("revoked");
  });

  it("leaves a workspace-level key active — it has no agent to be blocked by", async () => {
    await seedAgent({ id: "agt_IRRELEVANT", workspaceId: WORKSPACE_A, status: "disabled" });
    const plain = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read"] });
    const lister = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list"] });

    const body = (await (
      await SELF.fetch(`${URL_BASE}/v1/keys`, { headers: bearer(lister.token) })
    ).json()) as { keys: { id: string; status: string }[] };

    expect(body.keys.find(k => k.id === plain.keyId)?.status).toBe("active");
  });

  it("refuses an expiry already in the past", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["keys:create", "read"] });
    const res = await post("/v1/keys", token, { name: "stale", ops: ["read"], expiresAt: NOW - 1000 });
    expect(res.status).toBe(400);
  });

  it("records which key minted it", async () => {
    const parent = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "keys:create"] });
    const { key } = (await (
      await post("/v1/keys", parent.token, { name: "child", ops: ["read"] })
    ).json()) as { key: { id: string } };

    // So a compromised credential's descendants can be found rather than guessed.
    const row = await env.DB.prepare(`SELECT parent_key_id FROM api_keys WHERE id = ?`)
      .bind(key.id)
      .first<{ parent_key_id: string | null }>();
    expect(row?.parent_key_id).toBe(parent.keyId);
  });
});

describe("revoking keys", () => {
  it("stops the key on its very next request", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["keys:create", "read", "list"] });
    const minted = (await (
      await post("/v1/keys", token, { name: "doomed", ops: ["read"] })
    ).json()) as { secret: string; key: { id: string } };

    expect((await SELF.fetch(`${URL_BASE}/v1/whoami`, { headers: bearer(minted.secret) })).status).toBe(200);

    const revoked = await SELF.fetch(`${URL_BASE}/v1/keys/${minted.key.id}`, {
      method: "DELETE",
      headers: bearer(token),
    });
    expect(revoked.status).toBe(200);

    expect((await SELF.fetch(`${URL_BASE}/v1/whoami`, { headers: bearer(minted.secret) })).status).toBe(401);
  });

  it("is idempotent rather than an error the second time", async () => {
    // A retry after a dropped response should not look like a problem.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["keys:create", "read"] });
    const minted = (await (
      await post("/v1/keys", token, { name: "twice", ops: ["read"] })
    ).json()) as { key: { id: string } };

    const first = await SELF.fetch(`${URL_BASE}/v1/keys/${minted.key.id}`, { method: "DELETE", headers: bearer(token) });
    const second = await SELF.fetch(`${URL_BASE}/v1/keys/${minted.key.id}`, { method: "DELETE", headers: bearer(token) });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json()) as { alreadyRevoked: boolean }).toMatchObject({ alreadyRevoked: true });
  });

  it("cannot revoke a key in another workspace", async () => {
    const theirs = await seedApiKey({ workspaceId: WORKSPACE_B, ops: ["read"] });
    const mine = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["keys:create", "read"] });

    const res = await SELF.fetch(`${URL_BASE}/v1/keys/${theirs.keyId}`, {
      method: "DELETE",
      headers: bearer(mine.token),
    });
    expect(res.status).toBe(404);

    // And theirs still works.
    expect((await SELF.fetch(`${URL_BASE}/v1/whoami`, { headers: bearer(theirs.token) })).status).toBe(200);
  });
});
