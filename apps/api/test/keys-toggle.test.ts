/**
 * Switching a key off and on — migration 0024.
 *
 * Revoke was a one-way kill switch. The switch that replaced it is reversible,
 * and the thing that makes that safe is the rotation: enabling issues a **new**
 * secret, so a key switched off because its token leaked never comes back with
 * the leaked token. That is the property worth pinning, because it is the one
 * that would quietly disappear if somebody "fixed" enable to be a plain
 * `UPDATE ... SET disabled_at = NULL`.
 *
 * The other cases here are the ones where an apparent success would be a lie:
 * enabling a key whose *agent* is off, enabling an expired key, and enabling
 * one support has revoked.
 */

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { NOW, WORKSPACE_A, WORKSPACE_B, bearer, seedAgent, seedApiKey, seedTwoWorkspaces } from "./helpers";

const URL_BASE = "https://api-dev.agentdisk.io";

async function reset(): Promise<void> {
  await seedTwoWorkspaces();
  await env.DB.prepare(`DELETE FROM api_keys`).run();
  await env.DB.prepare(`DELETE FROM agents`).run();
  await env.DB.prepare(`DELETE FROM audit_events`).run();
}

const post = (path: string, token: string, body: unknown) =>
  SELF.fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const patch = (id: string, token: string, status: string) =>
  SELF.fetch(`${URL_BASE}/v1/keys/${id}`, {
    method: "PATCH",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });

const whoami = (secret: string) =>
  SELF.fetch(`${URL_BASE}/v1/whoami`, { headers: bearer(secret) });

const setAgent = (id: string, token: string, status: string) =>
  SELF.fetch(`${URL_BASE}/v1/agents/${id}`, {
    method: "PATCH",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });

const setAgentBody = (id: string, token: string, body: unknown) =>
  SELF.fetch(`${URL_BASE}/v1/agents/${id}`, {
    method: "PATCH",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const listKeys = async (token: string) =>
  ((await (await SELF.fetch(`${URL_BASE}/v1/keys`, { headers: bearer(token) })).json()) as {
    keys: { id: string; status: string; disabledBy: string | null }[];
  }).keys;

beforeEach(reset);

describe("PATCH /v1/keys/:id", () => {
  it("stops the key, then brings it back as a different key", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["keys:create", "read", "list"] });
    const minted = (await (
      await post("/v1/keys", token, { name: "toggle", ops: ["read"] })
    ).json()) as { secret: string; key: { id: string } };

    expect((await whoami(minted.secret)).status).toBe(200);

    const off = await patch(minted.key.id, token, "disabled");
    expect(off.status).toBe(200);
    expect(((await off.json()) as { key: { status: string; disabledBy: string } }).key).toMatchObject({
      status: "disabled",
      disabledBy: "key",
    });
    expect((await whoami(minted.secret)).status).toBe(401);

    const on = await patch(minted.key.id, token, "active");
    expect(on.status).toBe(200);
    const body = (await on.json()) as { secret: string; rotated: boolean; key: { id: string; status: string } };

    // The whole point. A new credential, on the same row.
    expect(body.rotated).toBe(true);
    expect(body.secret).not.toBe(minted.secret);
    expect(body.key.id).toBe(minted.key.id);
    expect(body.key.status).toBe("active");

    // The old token is dead for good, and the new one works.
    expect((await whoami(minted.secret)).status).toBe(401);
    expect((await whoami(body.secret)).status).toBe(200);

    const events = await env.DB.prepare(
      `SELECT action FROM audit_events WHERE resource_id = ? ORDER BY created_at`
    ).bind(minted.key.id).all<{ action: string }>();
    expect((events.results ?? []).map(e => e.action)).toContain("key.disabled");
    expect((events.results ?? []).map(e => e.action)).toContain("key.rotated");
  });

  it("does not rotate a key that is already on", async () => {
    // A no-op request must stay a no-op: rotating here would break whatever is
    // using the key right now, having been asked for no change at all.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["keys:create", "read", "list"] });
    const minted = (await (
      await post("/v1/keys", token, { name: "already-on", ops: ["read"] })
    ).json()) as { secret: string; key: { id: string } };

    const res = await patch(minted.key.id, token, "active");
    expect(res.status).toBe(200);
    expect((await res.json()) as { rotated?: boolean }).not.toHaveProperty("rotated");
    expect((await whoami(minted.secret)).status).toBe(200);
  });

  it("refuses to enable a key whose agent is off", async () => {
    // Rotating here would hand back a new secret that authentication refuses
    // on sight: a success message for something that did not work.
    const agentId = await seedAgent({ id: "agt_SWITCH", workspaceId: WORKSPACE_A });
    const agentKey = await seedApiKey({ workspaceId: WORKSPACE_A, agentId, ops: ["read"] });
    const lister = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list", "keys:create", "write"] });
    await setAgent(agentId, lister.token, "disabled");

    const list = (await (
      await SELF.fetch(`${URL_BASE}/v1/keys`, { headers: bearer(lister.token) })
    ).json()) as { keys: { id: string; status: string; disabledBy: string | null }[] };
    expect(list.keys.find(k => k.id === agentKey.keyId)).toMatchObject({
      status: "disabled",
      disabledBy: "agent",
    });

    const res = await patch(agentKey.keyId, lister.token, "active");
    expect(res.status).toBe(409);
  });

  it("refuses to enable an expired key", async () => {
    const lister = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list", "keys:create"] });
    const stale = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read"], expiresAt: NOW - 1000 });
    await env.DB.prepare(`UPDATE api_keys SET disabled_at = ? WHERE id = ?`).bind(NOW, stale.keyId).run();

    const res = await patch(stale.keyId, lister.token, "active");
    expect(res.status).toBe(409);
  });

  it("refuses to enable one support revoked", async () => {
    const lister = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list", "keys:create"] });
    const dead = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read"], revokedAt: NOW - 1000 });

    const res = await patch(dead.keyId, lister.token, "active");
    expect(res.status).toBe(409);
  });

  it("cannot touch a key in another workspace", async () => {
    const theirs = await seedApiKey({ workspaceId: WORKSPACE_B, ops: ["read"] });
    const mine = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["keys:create", "read"] });

    expect((await patch(theirs.keyId, mine.token, "disabled")).status).toBe(404);
  });

  it("needs keys:create, not merely write", async () => {
    // Enabling mints a credential. A key holding only `write` must not be able
    // to produce one, or the scope ceiling is decorative.
    const writer = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "write", "list"] });
    const target = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read"] });

    expect((await patch(target.keyId, writer.token, "disabled")).status).toBe(403);
  });
});

/**
 * The agent's switch drives its keys'.
 *
 * Before this, disabling an agent left its keys looking untouched in the list
 * while authentication refused them, and enabling brought the *same* secrets
 * back - so the rotation the key switch promises did not happen on the path
 * most people actually use. Each case below is one half of the round trip.
 */
describe("PATCH /v1/agents/:id cascades to its keys", () => {
  it("really disables them, and rotates them all on the way back", async () => {
    const admin = await seedApiKey({
      workspaceId: WORKSPACE_A,
      ops: ["read", "write", "list", "keys:create"],
    });
    const agentId = await seedAgent({ id: "agt_CASCADE", workspaceId: WORKSPACE_A });

    const minted = await Promise.all(
      ["one", "two"].map(async name =>
        (await (
          await post("/v1/keys", admin.token, { name, agentId, ops: ["read"] })
        ).json()) as { secret: string; key: { id: string } }
      )
    );
    for (const m of minted) expect((await whoami(m.secret)).status).toBe(200);

    const off = await setAgent(agentId, admin.token, "disabled");
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ keysDisabled: 2 });

    // Really off: the column, not merely the computed status.
    const disabled = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM api_keys WHERE agent_id = ? AND disabled_at IS NOT NULL
        AND disabled_reason = 'agent'`
    ).bind(agentId).first<{ n: number }>();
    expect(disabled?.n).toBe(2);
    for (const m of minted) expect((await whoami(m.secret)).status).toBe(401);

    const on = await setAgent(agentId, admin.token, "active");
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ keysRotated: 2 });

    // Back on, and every one of them is a different credential now.
    const keys = await listKeys(admin.token);
    for (const m of minted) {
      expect(keys.find(k => k.id === m.key.id)).toMatchObject({ status: "active", disabledBy: null });
      expect((await whoami(m.secret)).status).toBe(401);
    }
  });

  it("leaves a key the customer switched off themselves switched off", async () => {
    // Two independent decisions. Re-enabling an agent must not quietly undo
    // one somebody made about a particular credential.
    const admin = await seedApiKey({
      workspaceId: WORKSPACE_A,
      ops: ["read", "write", "list", "keys:create"],
    });
    const agentId = await seedAgent({ id: "agt_MINE", workspaceId: WORKSPACE_A });
    const mine = (await (
      await post("/v1/keys", admin.token, { name: "mine", agentId, ops: ["read"] })
    ).json()) as { key: { id: string } };
    const theirs = (await (
      await post("/v1/keys", admin.token, { name: "theirs", agentId, ops: ["read"] })
    ).json()) as { key: { id: string } };

    await patch(mine.key.id, admin.token, "disabled");
    await setAgent(agentId, admin.token, "disabled");
    const on = await setAgent(agentId, admin.token, "active");

    // Only the one the agent turned off comes back.
    expect(await on.json()).toMatchObject({ keysRotated: 1 });
    const keys = await listKeys(admin.token);
    expect(keys.find(k => k.id === mine.key.id)).toMatchObject({
      status: "disabled",
      disabledBy: "key",
    });
    expect(keys.find(k => k.id === theirs.key.id)).toMatchObject({ status: "active" });
  });

  it("does nothing to keys when the status did not change", async () => {
    const admin = await seedApiKey({
      workspaceId: WORKSPACE_A,
      ops: ["read", "write", "list", "keys:create"],
    });
    const agentId = await seedAgent({ id: "agt_RENAME", workspaceId: WORKSPACE_A });
    const minted = (await (
      await post("/v1/keys", admin.token, { name: "steady", agentId, ops: ["read"] })
    ).json()) as { secret: string };

    // A rename must not rotate anything, and neither must re-asserting the
    // status it already has.
    const renamed = await setAgentBody(agentId, admin.token, { name: "renamed" });
    expect(await renamed.json()).toMatchObject({ keysDisabled: 0, keysRotated: 0 });
    const same = await setAgent(agentId, admin.token, "active");
    expect(await same.json()).toMatchObject({ keysRotated: 0 });

    expect((await whoami(minted.secret)).status).toBe(200);
  });
});
