/**
 * Workspace members — 05 PART 13, 03 §8.22.
 *
 * Two families of case matter here. The first is the owner-protection set: an
 * invited admin who could demote or remove the account owner would be able to
 * lock the paying customer out of the thing they pay for, and that failure is
 * completely silent until it happens to somebody. The second is the key
 * cascade, where the wrong default in either direction is a real problem — one
 * leaves a departed colleague's credential running production traffic, the
 * other severs a key an agent depends on without anybody asking for it.
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withAuth, type WithAuthDeps } from "../src/middleware/auth";
import { toErrorResponse } from "../src/lib/errors";
import type { JwksCache } from "../src/auth/firebase";
import {
  changeMemberRole,
  inviteMember,
  listWorkspaceMembers,
  removeWorkspaceMember,
} from "../src/routes/members";
import { NOW, WORKSPACE_A, seedApiKey, seedTwoWorkspaces } from "./helpers";

const PROJECT_ID = "agentdisk-dev";
const KID = "members-test-key";
const ORG_ID = "org_TESTORG";

const OWNER = { id: "usr_MOWNER", uid: "fb-uid-mowner", email: "owner@example.com" };
const ADMIN = { id: "usr_MADMIN", uid: "fb-uid-madmin", email: "admin@example.com" };
const READER = { id: "usr_MREADER", uid: "fb-uid-mreader", email: "reader@example.com" };
const OUTSIDER = { id: "usr_MOUT", uid: "fb-uid-mout", email: "outsider@example.com" };

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
  const seconds = Math.floor(NOW / 1000);
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

function deps(): WithAuthDeps {
  const body = JSON.stringify({ keys: [publicJwk] });
  const cache: JwksCache = { async get() { return body; }, async put() {} };
  return {
    db: env.DB,
    files: env.FILES,
    signing: null,
    requestId: "req_TEST",
    now: NOW,
    firebase: { cache, projectId: PROJECT_ID },
  };
}

async function call(
  token: string,
  handler: Parameters<typeof withAuth>[3],
  init: { method?: string; body?: unknown; query?: string } = {}
): Promise<Response> {
  const url = `https://api.test/v1/members?workspaceId=${WORKSPACE_A}${init.query ?? ""}`;
  const request = new Request(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  try {
    return await withAuth(request, deps(), { op: null }, handler);
  } catch (thrown) {
    return toErrorResponse(thrown, "req_TEST");
  }
}

async function seedUser(
  u: { id: string; uid: string; email: string },
  verified = true
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, email, firebase_uid, email_verified_at, is_provisional,
                        session_revoked_after, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?)`
  ).bind(u.id, u.email, u.uid, verified ? NOW : null, NOW, NOW).run();
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

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicJwk = {
    ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey),
    kid: KID, alg: "RS256", use: "sig",
  };
});

beforeEach(async () => {
  await seedTwoWorkspaces();
  await env.DB.prepare(`DELETE FROM api_keys`).run();
  await env.DB.prepare(`DELETE FROM memberships WHERE user_id != 'usr_TESTUSER'`).run();
  await env.DB.prepare(`DELETE FROM users WHERE id != 'usr_TESTUSER'`).run();

  for (const u of [OWNER, ADMIN, READER, OUTSIDER]) await seedUser(u);
  await seedMembership("mem_OWNER", OWNER.id, "owner", null);
  await seedMembership("mem_ADMIN", ADMIN.id, "admin", WORKSPACE_A);
  await seedMembership("mem_READER", READER.id, "reader", WORKSPACE_A);
});

describe("listing", () => {
  it("shows the account owner and everyone invited here", async () => {
    const res = await call(await mint(OWNER.uid, OWNER.email), listWorkspaceMembers);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { members: { email: string; role: string; accountOwner: boolean }[] };
    expect(body.members.map(m => m.email).sort()).toEqual(
      [ADMIN.email, OWNER.email, READER.email].sort()
    );
    // The owner is marked, because the UI must not offer to remove them.
    expect(body.members.find(m => m.email === OWNER.email)?.accountOwner).toBe(true);
    expect(body.members.find(m => m.email === ADMIN.email)?.accountOwner).toBe(false);
  });

  it("is not readable with an agent key", async () => {
    // A key holds no role at all, so there is nothing for it to be a member as.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "list"] });
    const request = new Request(`https://api.test/v1/members?workspaceId=${WORKSPACE_A}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await withAuth(request, deps(), { op: null }, listWorkspaceMembers).catch(t =>
      toErrorResponse(t, "req_TEST")
    );
    expect(res.status).toBe(403);
  });
});

describe("inviting", () => {
  it("adds somebody who already has an account", async () => {
    const res = await call(await mint(OWNER.uid, OWNER.email), inviteMember, {
      method: "POST",
      body: { email: OUTSIDER.email, role: "reader" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { member: { email: string; role: string } };
    expect(body.member).toMatchObject({ email: OUTSIDER.email, role: "reader" });
  });

  it("refuses somebody with no account, and says so", async () => {
    // Staying vague here would leave an owner staring at a form that silently
    // does nothing - and it reveals nothing they did not already believe.
    const res = await call(await mint(OWNER.uid, OWNER.email), inviteMember, {
      method: "POST",
      body: { email: "nobody@example.com", role: "reader" },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("sign up first");
  });

  it("refuses an account that has not verified its address", async () => {
    // Anyone can type an address into a signup form. Letting an account that
    // has never proved it owns one receive an invitation addressed to it would
    // hand a squatter the access somebody meant for their colleague.
    const squatter = { id: "usr_SQUAT", uid: "fb-uid-squat", email: "colleague@example.com" };
    await seedUser(squatter, false);

    const res = await call(await mint(OWNER.uid, OWNER.email), inviteMember, {
      method: "POST",
      body: { email: squatter.email, role: "admin" },
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("not verified");
  });

  it("refuses a duplicate", async () => {
    const res = await call(await mint(OWNER.uid, OWNER.email), inviteMember, {
      method: "POST",
      body: { email: ADMIN.email, role: "reader" },
    });
    expect(res.status).toBe(409);
  });

  it("will not grant the owner role", async () => {
    // Owning the account comes with paying for it, not with an invitation.
    const res = await call(await mint(OWNER.uid, OWNER.email), inviteMember, {
      method: "POST",
      body: { email: OUTSIDER.email, role: "owner" },
    });
    expect(res.status).toBe(400);
  });

  it("refuses an invited admin", async () => {
    // An admin runs the workspace's contents; the owner runs its access.
    const res = await call(await mint(ADMIN.uid, ADMIN.email), inviteMember, {
      method: "POST",
      body: { email: OUTSIDER.email, role: "reader" },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a reader", async () => {
    const res = await call(await mint(READER.uid, READER.email), inviteMember, {
      method: "POST",
      body: { email: OUTSIDER.email, role: "reader" },
    });
    expect(res.status).toBe(403);
  });
});

describe("protecting the account owner", () => {
  it("will not let anybody demote the owner", async () => {
    const res = await call(await mint(OWNER.uid, OWNER.email), (ctx, req) =>
      changeMemberRole(ctx, req, "mem_OWNER")
    , { method: "PATCH", body: { role: "reader" } });
    // Even the owner themselves - a mis-click here locks the paying customer
    // out of everything they pay for.
    expect(res.status).toBe(403);
  });

  it("will not let anybody remove the owner", async () => {
    const res = await call(await mint(OWNER.uid, OWNER.email), (ctx, req) =>
      removeWorkspaceMember(ctx, req, "mem_OWNER")
    , { method: "DELETE" });
    expect(res.status).toBe(403);

    const still = await env.DB.prepare(`SELECT 1 AS ok FROM memberships WHERE id = 'mem_OWNER'`)
      .first<{ ok: number }>();
    expect(still?.ok).toBe(1);
  });
});

describe("changing a role", () => {
  it("promotes and demotes an invited member", async () => {
    const owner = await mint(OWNER.uid, OWNER.email);
    const res = await call(owner, (ctx, req) => changeMemberRole(ctx, req, "mem_READER"), {
      method: "PATCH",
      body: { role: "admin" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { member: { role: string } }).member.role).toBe("admin");
  });

  it("refuses an admin trying to promote themselves", async () => {
    const res = await call(await mint(ADMIN.uid, ADMIN.email), (ctx, req) =>
      changeMemberRole(ctx, req, "mem_ADMIN")
    , { method: "PATCH", body: { role: "admin" } });
    expect(res.status).toBe(403);
  });
});

describe("removing, and the key cascade", () => {
  async function seedKeyFor(userId: string, id: string): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO api_keys
         (id, workspace_id, agent_id, name, key_prefix, key_last_four, key_hash,
          scopes, created_by_user_id, parent_key_id, expires_at, last_used_at,
          revoked_at, created_at)
       VALUES (?, ?, NULL, ?, 'ask_live_x', 'abcd', ?, ?, ?, NULL, NULL, NULL, NULL, ?)`
    )
      .bind(id, WORKSPACE_A, `key for ${userId}`, `hash-${id}`,
            JSON.stringify({ ops: ["read"], pathPrefix: "" }), userId, NOW)
      .run();
  }

  it("removes the membership and leaves their keys alone by default", async () => {
    await seedKeyFor(ADMIN.id, "key_THEIRS");

    const res = await call(await mint(OWNER.uid, OWNER.email), (ctx, req) =>
      removeWorkspaceMember(ctx, req, "mem_ADMIN")
    , { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { keysRevoked: number }).toMatchObject({ keysRevoked: 0 });

    // A key an agent depends on must not be severed by a request that never
    // asked for it.
    const key = await env.DB.prepare(`SELECT revoked_at FROM api_keys WHERE id = 'key_THEIRS'`)
      .first<{ revoked_at: number | null }>();
    expect(key?.revoked_at).toBeNull();
  });

  it("revokes their keys when asked", async () => {
    await seedKeyFor(ADMIN.id, "key_ONE");
    await seedKeyFor(ADMIN.id, "key_TWO");
    await seedKeyFor(READER.id, "key_SOMEBODY_ELSE");

    const res = await call(await mint(OWNER.uid, OWNER.email), (ctx, req) =>
      removeWorkspaceMember(ctx, req, "mem_ADMIN")
    , { method: "DELETE", query: "&revokeKeys=true" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { keysRevoked: number }).toMatchObject({ keysRevoked: 2 });

    // Only theirs.
    const other = await env.DB.prepare(
      `SELECT revoked_at FROM api_keys WHERE id = 'key_SOMEBODY_ELSE'`
    ).first<{ revoked_at: number | null }>();
    expect(other?.revoked_at).toBeNull();
  });

  it("ends their access to the workspace immediately", async () => {
    await call(await mint(OWNER.uid, OWNER.email), (ctx, req) =>
      removeWorkspaceMember(ctx, req, "mem_READER")
    , { method: "DELETE" });

    const res = await call(await mint(READER.uid, READER.email), listWorkspaceMembers);
    expect(res.status).toBe(403);
  });
});
