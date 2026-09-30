/**
 * `DELETE /v1/me` — a person closing their own account, end to end through the
 * real Worker with a real RSA-signed Firebase token.
 *
 * Written to check the lifecycle diagram against the running code rather than
 * against a reading of it. Each test names the diagram step it exercises.
 */

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NOW, WORKSPACE_A, seedApiKey, seedTwoWorkspaces } from "./helpers";
import { ACCOUNT_PURGE_TTL_MS } from "../src/db/workspace-cascade";
import { deleteOwnAccount, type StripeTeardownClient } from "../src/routes/account";
import type { AuthContext } from "../src/middleware/auth";

const URL_BASE = "https://api-dev.agentdisk.io";
const PROJECT_ID = "agentdisk-dev";
const KID = "acct-test-key";
const HOST_ORG = "org_TESTORG"; // seedTwoWorkspaces' org: somebody else's account
const OWNER = "usr_ACCTOWNER";
const OWNER_UID = "firebase-uid-acct-owner";
const OWNER_EMAIL = "acctowner@example.com";
const OWN_ORG = "org_ACCTOWNED";

type TestJwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
let privateKey: CryptoKey;
let publicJwk: TestJwk;

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function seg(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}
async function mint(uid: string, email: string): Promise<string> {
  const seconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: KID, typ: "JWT" };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: uid,
    iat: seconds,
    exp: seconds + 3600,
    email,
    email_verified: true,
    firebase: { sign_in_provider: "password" },
  };
  const input = `${seg(header)}.${seg(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(input)
  );
  return `${input}.${b64url(new Uint8Array(signature))}`;
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

/** One workspace under the owner's own org, with a key, an agent, a webhook and a file. */
async function ownedWorkspace(id: string, name: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workspaces (id, org_id, name, period_reset_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, OWN_ORG, name, NOW, NOW, NOW).run();
  await env.FILES.put(`ws/${id}/file_${id}`, "bytes");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO files (id, workspace_id, folder_id, name, path, r2_object_key, size_bytes,
                          mime_type, status, created_by, created_at, updated_at)
       VALUES (?, ?, NULL, 'a.txt', '/a.txt', ?, 5, 'text/plain', 'active', ?, ?, ?)`
    ).bind(`file_${id}`, id, `ws/${id}/file_${id}`, OWNER, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO agents (id, workspace_id, name, status, created_by_user_id, created_at)
       VALUES (?, ?, 'bot', 'active', ?, ?)`
    ).bind(`agt_${id}`, id, OWNER, NOW),
    env.DB.prepare(
      `INSERT INTO api_keys (id, workspace_id, agent_id, name, key_prefix, key_last_four,
                             key_hash, scopes, created_by_user_id, created_at)
       VALUES (?, ?, ?, 'k', 'ad_live_x', 'abcd', ?, '{"ops":["read"],"pathPrefix":"/*"}', ?, ?)`
    ).bind(`key_${id}`, id, `agt_${id}`, `hash_${id}`, OWNER, NOW),
    env.DB.prepare(
      `INSERT INTO webhooks (id, workspace_id, url, secret, events, created_at)
       VALUES (?, ?, 'https://example.com/h', 'enc', '["file.created"]', ?)`
    ).bind(`wh_${id}`, id, NOW),
  ]);
}

const OWNED_1 = "ws_ACCTOWNED1AAAAAAAAAAAAAAAA";
const OWNED_2 = "ws_ACCTOWNED2AAAAAAAAAAAAAAAA";

beforeEach(async () => {
  await seedTwoWorkspaces();
  await env.CACHE.put("firebase:jwks:v1", JSON.stringify({ keys: [publicJwk] }));

  for (const table of ["pending_deletions", "job_runs", "share_links", "file_tags", "files", "folders", "api_keys", "agents", "webhooks", "audit_events"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(`DELETE FROM memberships WHERE user_id != 'usr_TESTUSER'`).run();
  await env.DB.prepare(`DELETE FROM workspaces WHERE id NOT LIKE 'ws_AAA%' AND id NOT LIKE 'ws_BBB%'`).run();
  await env.DB.prepare(`DELETE FROM organizations WHERE id != ?`).bind(HOST_ORG).run();
  await env.DB.prepare(`DELETE FROM users WHERE id != 'usr_TESTUSER'`).run();

  // The person: their own billing account with two workspaces they own...
  await env.DB.prepare(
    `INSERT INTO users (id, email, firebase_uid, is_provisional, session_revoked_after, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, ?, ?)`
  ).bind(OWNER, OWNER_EMAIL, OWNER_UID, NOW, NOW).run();
  // No Stripe customer by default: the test env carries a dummy STRIPE_SECRET_KEY,
  // so a customer id here would make the HTTP tests reach for the real Stripe and
  // be refused. The billing tests below attach one and pass a fake client.
  await env.DB.prepare(
    `INSERT INTO organizations (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(OWN_ORG, "Owned", OWNER, NOW, NOW).run();
  // The host pays Stripe too. Nothing below may touch this customer.
  await env.DB.prepare(`UPDATE organizations SET stripe_customer_id = 'cus_HOST' WHERE id = ?`)
    .bind(HOST_ORG)
    .run();
  await env.DB.prepare(
    `INSERT INTO memberships (id, org_id, user_id, workspace_id, role, created_at)
     VALUES ('mem_ACCTOWNER', ?, ?, NULL, 'owner', ?)`
  ).bind(OWN_ORG, OWNER, NOW).run();
  await ownedWorkspace(OWNED_1, "Owned One");
  await ownedWorkspace(OWNED_2, "Owned Two");

  // ...and a guest seat, as a reader, in somebody else's workspace.
  await env.DB.prepare(
    `INSERT INTO memberships (id, org_id, user_id, workspace_id, role, created_at)
     VALUES ('mem_ACCTGUEST', ?, ?, ?, 'reader', ?)`
  ).bind(HOST_ORG, OWNER, WORKSPACE_A, NOW).run();
});

function del(token: string, workspaceId: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${URL_BASE}/v1/me?workspaceId=${workspaceId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function exists(table: string, id: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ?`).bind(id).first();
  return row !== null;
}

describe("DELETE /v1/me - gates (steps 4-5)", () => {
  it("refuses an API key, whatever its scope", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const res = await SELF.fetch(`${URL_BASE}/v1/me`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ confirmEmail: "test@example.com" }),
    });
    expect(res.status).toBe(403);
    expect(await exists("workspaces", WORKSPACE_A)).toBe(true);
  });

  it("refuses a wrong confirmation email and destroys nothing", async () => {
    const token = await mint(OWNER_UID, OWNER_EMAIL);
    const res = await del(token, OWNED_1, { confirmEmail: "someone-else@example.com" });
    expect(res.status).toBe(400);
    expect(await exists("workspaces", OWNED_1)).toBe(true);
    expect(await exists("workspaces", OWNED_2)).toBe(true);
  });

  it("accepts the email in a different case", async () => {
    const token = await mint(OWNER_UID, OWNER_EMAIL);
    const res = await del(token, OWNED_1, { confirmEmail: OWNER_EMAIL.toUpperCase() });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /v1/me - what goes now (steps 8-11)", () => {
  it("hard-deletes every owned workspace with its keys, agents and webhooks, and queues the bytes", async () => {
    const token = await mint(OWNER_UID, OWNER_EMAIL);
    const res = await del(token, OWNED_1, { confirmEmail: OWNER_EMAIL });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspacesDeleted: number; filesQueued: number; purgeAfter: string };

    for (const ws of [OWNED_1, OWNED_2]) {
      expect(await exists("workspaces", ws)).toBe(false);
      expect(await exists("api_keys", `key_${ws}`)).toBe(false);
      expect(await exists("agents", `agt_${ws}`)).toBe(false);
      expect(await exists("webhooks", `wh_${ws}`)).toBe(false);
      expect(await exists("files", `file_${ws}`)).toBe(false);
      // The bytes wait for the sweep; the row that names them moved tables.
      expect(await env.FILES.get(`ws/${ws}/file_${ws}`)).not.toBeNull();
      const pending = await env.DB.prepare(
        `SELECT source, due_at FROM pending_deletions WHERE file_id = ?`
      ).bind(`file_${ws}`).first<{ source: string; due_at: number }>();
      expect(pending?.source).toBe("account_delete");
    }
    expect(body.filesQueued).toBe(2);
  });

  it("stamps the tombstone: deleted_at, session revoked, purge in 7 days, address kept", async () => {
    const token = await mint(OWNER_UID, OWNER_EMAIL);
    await del(token, OWNED_1, { confirmEmail: OWNER_EMAIL });

    const row = await env.DB.prepare(
      `SELECT email, firebase_uid, deleted_at, purge_after, session_revoked_after FROM users WHERE id = ?`
    ).bind(OWNER).first<{ email: string; firebase_uid: string | null; deleted_at: number | null; purge_after: number | null; session_revoked_after: number }>();
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.purge_after).toBe((row?.deleted_at ?? 0) + ACCOUNT_PURGE_TTL_MS);
    expect(row?.session_revoked_after).toBe(row?.deleted_at);
    // Held for the window so the day-7 message can reach it.
    expect(row?.email).toBe(OWNER_EMAIL);
    expect(row?.firebase_uid).toBe(OWNER_UID);
  });

  it("refuses the person's token afterwards (step 15)", async () => {
    const token = await mint(OWNER_UID, OWNER_EMAIL);
    await del(token, OWNED_1, { confirmEmail: OWNER_EMAIL });

    const again = await SELF.fetch(`${URL_BASE}/v1/whoami?workspaceId=${WORKSPACE_A}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.status).toBe(401);
  });
});

describe("DELETE /v1/me - the guest rule (steps 8-9)", () => {
  it("leaves the host's workspace standing when the person was only a guest in it", async () => {
    // The person owns OWNED_1/2 and is a READER in WORKSPACE_A, which belongs to
    // another account. Closing their account must remove their seat, never the
    // host's workspace.
    const token = await mint(OWNER_UID, OWNER_EMAIL);
    const res = await del(token, OWNED_1, { confirmEmail: OWNER_EMAIL });
    expect(res.status).toBe(200);

    expect(await exists("workspaces", WORKSPACE_A)).toBe(true);
    expect(await exists("memberships", "mem_ACCTGUEST")).toBe(false);
    // And the host's files are neither deleted nor queued.
    const hostFiles = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM pending_deletions WHERE workspace_id = ?`
    ).bind(WORKSPACE_A).first<{ n: number }>();
    expect(hostFiles?.n).toBe(0);
  });

  it("can be called while the open workspace is the guest one", async () => {
    // The dashboard's Account screen is reachable from any workspace, including
    // one the person merely reads. Their account is still theirs to close.
    const token = await mint(OWNER_UID, OWNER_EMAIL);
    const res = await del(token, WORKSPACE_A, { confirmEmail: OWNER_EMAIL });
    expect(res.status).toBe(200);
    expect(await exists("workspaces", WORKSPACE_A)).toBe(true);
    expect(await exists("workspaces", OWNED_1)).toBe(false);
  });
});

/* ------------------------------ billing step ------------------------------ */

/**
 * A recording fake for the slice of Stripe the route uses. The real client is
 * never constructed in tests; what is under test is which subscriptions the
 * route decides to cancel, whose customer it touches, and what a failure does.
 */
function fakeStripe(options: {
  subscriptions?: Record<string, { id: string; status: string; schedule?: string | null }[]>;
  cards?: Record<string, string[]>;
  failOnCancel?: boolean;
}) {
  const calls = { cancelled: [] as string[], released: [] as string[], detached: [] as string[], listedFor: [] as string[] };
  const client: StripeTeardownClient = {
    subscriptions: {
      async list({ customer }) {
        calls.listedFor.push(customer);
        return { data: options.subscriptions?.[customer] ?? [] };
      },
      async cancel(id) {
        if (options.failOnCancel) throw new Error("stripe is down");
        calls.cancelled.push(id);
        return {};
      },
    },
    subscriptionSchedules: {
      async release(id) {
        calls.released.push(id);
        return {};
      },
    },
    paymentMethods: {
      async list({ customer }) {
        return { data: (options.cards?.[customer] ?? []).map((id) => ({ id })) };
      },
      async detach(id) {
        calls.detached.push(id);
        return {};
      },
    },
  };
  return { client, calls };
}

/** Just enough context for the handler: a signed-in person, now, a request id. */
function asOwner(): AuthContext {
  return {
    identity: { kind: "firebase_user", userId: OWNER },
    now: NOW,
    requestId: "req_ACCT",
  } as unknown as AuthContext;
}

function confirm(): Request {
  return new Request(`${URL_BASE}/v1/me`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmEmail: OWNER_EMAIL }),
  });
}

describe("DELETE /v1/me - ending billing (step 6)", () => {
  beforeEach(async () => {
    await env.DB.prepare(`UPDATE organizations SET stripe_customer_id = 'cus_OWN' WHERE id = ?`)
      .bind(OWN_ORG)
      .run();
  });

  it("cancels every subscription that is not already over, on the owned customer only", async () => {
    const stripe = fakeStripe({
      subscriptions: {
        cus_OWN: [
          { id: "sub_active", status: "active" },
          { id: "sub_pastdue", status: "past_due" },
          { id: "sub_trial", status: "trialing", schedule: "sched_DOWNGRADE" },
          { id: "sub_old", status: "canceled" },
        ],
        cus_HOST: [{ id: "sub_HOST", status: "active" }],
      },
      cards: { cus_OWN: ["pm_visa"], cus_HOST: ["pm_HOSTCARD"] },
    });

    const res = await deleteOwnAccount(asOwner(), confirm(), {
      db: env.DB,
      files: env.FILES,
      stripe: stripe.client,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { billing: string }).billing).toBe("cancelled");

    expect(stripe.calls.cancelled.sort()).toEqual(["sub_active", "sub_pastdue", "sub_trial"]);
    expect(stripe.calls.released).toEqual(["sched_DOWNGRADE"]);
    expect(stripe.calls.detached).toEqual(["pm_visa"]);
    // The host's customer was never even read.
    expect(stripe.calls.listedFor).toEqual(["cus_OWN"]);
  });

  it("refuses and destroys nothing when Stripe fails", async () => {
    const stripe = fakeStripe({
      subscriptions: { cus_OWN: [{ id: "sub_active", status: "active" }] },
      failOnCancel: true,
    });

    await expect(
      deleteOwnAccount(asOwner(), confirm(), { db: env.DB, files: env.FILES, stripe: stripe.client })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await exists("workspaces", OWNED_1)).toBe(true);
    expect(await exists("api_keys", `key_${OWNED_1}`)).toBe(true);
    expect(await exists("memberships", "mem_ACCTGUEST")).toBe(true);
    const user = await env.DB.prepare(`SELECT deleted_at FROM users WHERE id = ?`).bind(OWNER).first<{ deleted_at: number | null }>();
    expect(user?.deleted_at).toBeNull();
  });

  it("reports unconfigured, and still closes, when this deployment has no Stripe key", async () => {
    const res = await deleteOwnAccount(asOwner(), confirm(), { db: env.DB, files: env.FILES });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { billing: string }).billing).toBe("unconfigured");
    expect(await exists("workspaces", OWNED_1)).toBe(false);
  });
});

describe("DELETE /v1/me - the cascade cap", () => {
  it("refuses above 20 owned workspaces and destroys none of them", async () => {
    for (let i = 3; i <= 21; i += 1) {
      const id = `ws_ACCTMANY${String(i).padStart(2, "0")}AAAAAAAAAAAAAAA`;
      await env.DB.prepare(
        `INSERT INTO workspaces (id, org_id, name, period_reset_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, OWN_ORG, `Many ${i}`, NOW, NOW, NOW).run();
    }
    const token = await mint(OWNER_UID, OWNER_EMAIL);
    const res = await del(token, OWNED_1, { confirmEmail: OWNER_EMAIL });
    expect(res.status).toBe(429);
    expect(await exists("workspaces", OWNED_1)).toBe(true);
    const user = await env.DB.prepare(`SELECT deleted_at FROM users WHERE id = ?`).bind(OWNER).first<{ deleted_at: number | null }>();
    expect(user?.deleted_at).toBeNull();
  });
});
