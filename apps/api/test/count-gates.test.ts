/**
 * The plan's count gates: workspaces, agents, API keys, members.
 *
 * Until 4 Oct 2026 the pricing page said "1 workspace, 1 agent, 2 API keys"
 * and the API created a twentieth of each. These are the tests that would
 * have failed then. Each dimension gets the same four questions: does the
 * ceiling refuse, is the count account-wide rather than per workspace, does
 * removing something free the slot, and does the refusal carry the numbers
 * the dashboard needs.
 */

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  NOW,
  ORG_ID,
  WORKSPACE_A,
  WORKSPACE_B,
  bearer,
  seedAgent,
  seedApiKey,
  seedTwoWorkspaces,
  setOrgPlan,
} from "./helpers";
import { provisionSandboxWorkspace } from "../src/db/bootstrap";
import { assertCountWithinPlan } from "../src/lib/count-gate";
import { PLAN_LIMITS, UNLIMITED } from "../src/lib/plans";
import type { OrgCounts } from "../src/db/org-counts";

const URL_BASE = "https://api-dev.agentdisk.io";
const PROJECT_ID = "agentdisk-dev";
const KID = "count-gates-test-key";

const OWNER = { id: "usr_CGOWNER", uid: "fb-uid-cgowner", email: "cg-owner@example.com" };
const ALICE = { id: "usr_CGALICE", uid: "fb-uid-cgalice", email: "cg-alice@example.com" };
const BOB = { id: "usr_CGBOB", uid: "fb-uid-cgbob", email: "cg-bob@example.com" };

type TestJwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
let privateKey: CryptoKey;
let publicJwk: TestJwk;

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const seg = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function mint(uid: string, email: string): Promise<string> {
  const seconds = Math.floor(Date.now() / 1000);
  const input = `${seg({ alg: "RS256", kid: KID, typ: "JWT" })}.${seg({
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: uid,
    iat: seconds,
    exp: seconds + 3600,
    email,
    email_verified: true,
    firebase: { sign_in_provider: "password" },
  })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(input)
  );
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

async function seedUser(u: { id: string; uid: string; email: string }): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, email, firebase_uid, email_verified_at, is_provisional,
                        session_revoked_after, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?)`
  ).bind(u.id, u.email, u.uid, NOW, NOW, NOW).run();
}

async function seedMembership(
  id: string,
  userId: string,
  role: string,
  workspaceId: string | null
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO memberships (id, org_id, user_id, workspace_id, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, ORG_ID, userId, workspaceId, role, NOW).run();
}

function asUser(token: string, body?: unknown, method?: string): RequestInit {
  return {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function post(path: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface Refusal {
  error: { code: string; message: string; details: { limit: string; used: number; allowed: number } };
}

async function expectRefusal(
  res: Response,
  limit: string,
  used: number,
  allowed: number,
  message: string
): Promise<void> {
  expect(res.status).toBe(403);
  const body = (await res.json()) as Refusal;
  expect(body.error.code).toBe("FORBIDDEN");
  expect(body.error.message).toBe(message);
  expect(body.error.details).toEqual({ limit, used, allowed });
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicJwk = {
    ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey),
    kid: KID,
    alg: "RS256",
    use: "sig",
  };
});

beforeEach(async () => {
  await seedTwoWorkspaces();
  await env.CACHE.put("firebase:jwks:v1", JSON.stringify({ keys: [publicJwk] }));

  for (const table of ["audit_events", "api_keys", "agents", "pending_deletions", "job_runs"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(`DELETE FROM memberships WHERE user_id != 'usr_TESTUSER'`).run();
  await env.DB.prepare(`DELETE FROM workspaces WHERE id NOT IN (?, ?)`).bind(WORKSPACE_A, WORKSPACE_B).run();
  await env.DB.prepare(`UPDATE workspaces SET deleted_at = NULL WHERE id IN (?, ?)`).bind(WORKSPACE_A, WORKSPACE_B).run();
  await env.DB.prepare(`DELETE FROM organizations WHERE id != ?`).bind(ORG_ID).run();
  await env.DB.prepare(`DELETE FROM users WHERE id != 'usr_TESTUSER'`).run();
  await env.DB.prepare(`UPDATE organizations SET plan = 'free', plan_override = NULL, owner_user_id = ? WHERE id = ?`)
    .bind(OWNER.id, ORG_ID)
    .run();

  for (const u of [OWNER, ALICE, BOB]) await seedUser(u);
  await seedMembership("mem_CGOWNER", OWNER.id, "owner", null);
});

describe("agents", () => {
  it("refuses the agent past the plan, with the numbers", async () => {
    await seedAgent({ id: "agent_ONE" });
    const { token } = await seedApiKey({ ops: ["write"] });

    await expectRefusal(
      await post("/v1/agents", token, { name: "second" }),
      "agents",
      1,
      PLAN_LIMITS.free.agents,
      "Your Free plan allows 1 agent. Upgrade to add more."
    );
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM agents`).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("counts across every workspace on the bill, and a delete frees the slot", async () => {
    await setOrgPlan("basic");
    for (const id of ["a1", "a2", "a3"]) await seedAgent({ id: `agent_${id}`, workspaceId: WORKSPACE_A });
    for (const id of ["b1", "b2"]) await seedAgent({ id: `agent_${id}`, workspaceId: WORKSPACE_B });
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write", "delete"] });

    await expectRefusal(
      await post("/v1/agents", token, { name: "sixth" }),
      "agents",
      5,
      PLAN_LIMITS.basic.agents,
      "Your Basic plan allows 5 agents. Upgrade to add more."
    );

    const deleted = await SELF.fetch(`${URL_BASE}/v1/agents/agent_a3`, { method: "DELETE", headers: bearer(token) });
    expect(deleted.status).toBe(200);
    expect((await post("/v1/agents", token, { name: "sixth" })).status).toBe(201);
  });

  it("does not count agents in a deleted workspace", async () => {
    await seedAgent({ id: "agent_GONE", workspaceId: WORKSPACE_B });
    await env.DB.prepare(`UPDATE workspaces SET deleted_at = ? WHERE id = ?`).bind(NOW, WORKSPACE_B).run();
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write"] });

    expect((await post("/v1/agents", token, { name: "first-live" })).status).toBe(201);
  });

  it("holds an unclaimed sandbox to its one agent, and says how to get more", async () => {
    const sandbox = await provisionSandboxWorkspace(env.DB, {
      workspaceName: "Trial",
      agentName: "trial-bot",
      now: NOW,
      creatorIp: "203.0.113.9",
    });

    await expectRefusal(
      await post("/v1/agents", sandbox.token, { name: "second" }),
      "agents",
      1,
      1,
      "This sandbox allows 1 agent. Claim it to add more."
    );
  });
});

describe("API keys", () => {
  it("refuses the key past the plan, and a revoked key frees the slot", async () => {
    const { token, keyId } = await seedApiKey({ ops: ["keys:create", "read"] });

    const first = await post("/v1/keys", token, { name: "one", ops: ["read"] });
    expect(first.status).toBe(201);
    const { key } = (await first.json()) as { key: { id: string } };

    await expectRefusal(
      await post("/v1/keys", token, { name: "two", ops: ["read"] }),
      "apiKeys",
      2,
      PLAN_LIMITS.free.apiKeys,
      "Your Free plan allows 2 API keys. Upgrade to add more."
    );
    expect(keyId).not.toBe(key.id);

    await env.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`).bind(NOW, key.id).run();
    expect((await post("/v1/keys", token, { name: "two", ops: ["read"] })).status).toBe(201);
  });

  it("counts keys in the sibling workspace too", async () => {
    await seedApiKey({ workspaceId: WORKSPACE_B });
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["keys:create", "read"] });

    await expectRefusal(
      await post("/v1/keys", token, { name: "three", ops: ["read"] }),
      "apiKeys",
      2,
      2,
      "Your Free plan allows 2 API keys. Upgrade to add more."
    );
  });

  it("reports a bad request as a bad request even when the plan is full", async () => {
    await seedApiKey({ workspaceId: WORKSPACE_B });
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["keys:create", "read"] });

    const res = await post("/v1/keys", token, { name: "a-name-far-longer-than-allowed", ops: ["read"] });
    expect(res.status).toBe(400);
  });
});

describe("members", () => {
  const members = (workspaceId: string) => `/v1/members?workspaceId=${workspaceId}`;

  it("lets the owner invite up to the plan, never counting themselves", async () => {
    const token = await mint(OWNER.uid, OWNER.email);

    const first = await SELF.fetch(
      `${URL_BASE}${members(WORKSPACE_A)}`,
      asUser(token, { email: ALICE.email, role: "reader" })
    );
    expect(first.status).toBe(201);

    await expectRefusal(
      await SELF.fetch(`${URL_BASE}${members(WORKSPACE_A)}`, asUser(token, { email: BOB.email, role: "reader" })),
      "members",
      1,
      PLAN_LIMITS.free.members,
      "Your Free plan allows 1 member. Upgrade to add more."
    );
  });

  it("does not charge a second slot for the same person in a sibling workspace", async () => {
    await seedMembership("mem_CGALICE_A", ALICE.id, "reader", WORKSPACE_A);
    const token = await mint(OWNER.uid, OWNER.email);

    const res = await SELF.fetch(
      `${URL_BASE}${members(WORKSPACE_B)}`,
      asUser(token, { email: ALICE.email, role: "reader" })
    );
    expect(res.status).toBe(201);

    await expectRefusal(
      await SELF.fetch(`${URL_BASE}${members(WORKSPACE_B)}`, asUser(token, { email: BOB.email, role: "reader" })),
      "members",
      1,
      1,
      "Your Free plan allows 1 member. Upgrade to add more."
    );
  });

  it("removing a member frees the slot", async () => {
    await seedMembership("mem_CGALICE_A", ALICE.id, "reader", WORKSPACE_A);
    const token = await mint(OWNER.uid, OWNER.email);

    const removed = await SELF.fetch(
      `${URL_BASE}/v1/members/mem_CGALICE_A?workspaceId=${WORKSPACE_A}`,
      asUser(token, undefined, "DELETE")
    );
    expect(removed.status).toBe(200);

    const res = await SELF.fetch(
      `${URL_BASE}${members(WORKSPACE_A)}`,
      asUser(token, { email: BOB.email, role: "reader" })
    );
    expect(res.status).toBe(201);
  });
});

describe("workspaces", () => {
  const create = async (name: string) =>
    SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(await mint(OWNER.uid, OWNER.email), { name }));

  it("refuses a Free account that already holds its one workspace", async () => {
    // The fixture seeds two, which is already over; the gate reports what is
    // there rather than pretending.
    await expectRefusal(
      await create("Third"),
      "workspaces",
      2,
      PLAN_LIMITS.free.workspaces,
      "Your Free plan allows 1 workspace. Upgrade to add more."
    );
  });

  it("stops Basic at three, and a deleted workspace frees the slot", async () => {
    await setOrgPlan("basic");

    const third = await create("Third");
    expect(third.status).toBe(201);
    const { workspace } = (await third.json()) as { workspace: { id: string } };

    await expectRefusal(
      await create("Fourth"),
      "workspaces",
      3,
      PLAN_LIMITS.basic.workspaces,
      "Your Basic plan allows 3 workspaces. Upgrade to add more."
    );

    await env.DB.prepare(`UPDATE workspaces SET deleted_at = ? WHERE id = ?`).bind(NOW, workspace.id).run();
    expect((await create("Fourth")).status).toBe(201);
  });

  it("honours the account's plan override over its plan", async () => {
    await env.DB.prepare(`UPDATE organizations SET plan = 'free', plan_override = 'pro' WHERE id = ?`)
      .bind(ORG_ID)
      .run();
    expect((await create("Third")).status).toBe(201);
  });

  it("names the plan the account is actually on", async () => {
    await setOrgPlan("team");
    for (let i = 3; i <= PLAN_LIMITS.team.workspaces; i++) {
      await env.DB.prepare(
        `INSERT INTO workspaces (id, org_id, name, period_reset_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(`ws_CG${i}`, ORG_ID, `Filler ${i}`, NOW, NOW, NOW).run();
    }

    await expectRefusal(
      await create("Fifty-first"),
      "workspaces",
      PLAN_LIMITS.team.workspaces,
      PLAN_LIMITS.team.workspaces,
      "Your Team plan allows 50 workspaces. Upgrade to add more."
    );
  });
});

describe("the gate itself", () => {
  const claimed = { claimed_at: NOW, claim_token_hash: null, org_plan: "team", org_plan_override: null };

  it("never counts when the plan is unlimited", async () => {
    const counts = {
      agents: async () => {
        throw new Error("counted");
      },
    } as unknown as OrgCounts;

    await expect(
      assertCountWithinPlan(counts, "agents", { ...PLAN_LIMITS.team, agents: UNLIMITED }, claimed)
    ).resolves.toBeUndefined();
  });

  it("says a zero allowance is not included rather than 'allows 0'", async () => {
    const counts = { members: async () => 0 } as unknown as OrgCounts;

    await expect(
      assertCountWithinPlan(counts, "members", { ...PLAN_LIMITS.free, members: 0 }, claimed)
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Your Team plan doesn't include members. Upgrade to add some.",
    });
  });
});
