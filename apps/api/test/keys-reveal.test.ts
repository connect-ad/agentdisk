/**
 * Viewing a key again — migration 0022, lib/secretbox.ts, GET /v1/keys/:id/secret.
 *
 * Keys used to exist nowhere after creation, and "you won't see it again" was
 * the whole of the protection. Now they are kept, sealed, and one route opens
 * them. Every case below is a refusal or a guarantee that replaces that old
 * protection, so each one failing would be a real regression rather than a
 * cosmetic one: an API key reading keys is escalation, a reader reading keys
 * is escalation, a ciphertext that opens for the wrong row is a way to make
 * key A reveal as key B, and a reveal that is not audited is a reveal the
 * owner never finds out about.
 *
 * The human cases drive `withAuth` directly with a fake JWKS, the way
 * members.test.ts does, because a signed-in person is the only caller this
 * route serves and the router alone cannot mint one.
 */

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withAuth, type WithAuthDeps } from "../src/middleware/auth";
import { toErrorResponse } from "../src/lib/errors";
import type { JwksCache } from "../src/auth/firebase";
import { createKey, revealKey } from "../src/routes/keys";
import { openSecret, sealSecret } from "../src/lib/secretbox";
import { provisionSandboxWorkspace } from "../src/db/bootstrap";
import { NOW, WORKSPACE_A, WORKSPACE_B, bearer, seedApiKey, seedTwoWorkspaces } from "./helpers";

const URL_BASE = "https://api-dev.agentdisk.io";
const PROJECT_ID = "agentdisk-dev";
const KID = "reveal-test-key";
const ORG_ID = "org_TESTORG";
const SECRET = "test-database-encryption-key";

const OWNER = { id: "usr_ROWNER", uid: "fb-uid-rowner", email: "owner@example.com" };
const READER = { id: "usr_RREADER", uid: "fb-uid-rreader", email: "reader@example.com" };

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

/**
 * No default parameter, on purpose: a default applies to `undefined`, so a
 * caller passing "no secret" as undefined would silently get the secret. Null
 * is the only spelling of "none" here.
 */
function deps(encryptionKey: string | null): WithAuthDeps {
  const body = JSON.stringify({ keys: [publicJwk] });
  const cache: JwksCache = { async get() { return body; }, async put() {} };
  return {
    db: env.DB,
    files: env.FILES,
    signing: null,
    requestId: "req_TEST",
    now: NOW,
    firebase: { cache, projectId: PROJECT_ID },
    ...(encryptionKey === null ? {} : { encryptionKey }),
  };
}

async function call(
  token: string,
  path: string,
  handler: Parameters<typeof withAuth>[3],
  init: { method?: string; body?: unknown; encryptionKey?: string | null } = {}
): Promise<Response> {
  const request = new Request(`https://api.test${path}?workspaceId=${WORKSPACE_A}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  try {
    return await withAuth(
      request,
      deps(init.encryptionKey === null ? null : SECRET),
      { op: "keys:create" },
      handler
    );
  } catch (thrown) {
    return toErrorResponse(thrown, "req_TEST");
  }
}

async function seedUser(u: { id: string; uid: string; email: string }): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, email, firebase_uid, email_verified_at, is_provisional,
                        session_revoked_after, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?)`
  ).bind(u.id, u.email, u.uid, NOW, NOW, NOW).run();
}

async function seedMembership(id: string, userId: string, role: string, workspaceId: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO memberships (id, org_id, user_id, workspace_id, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, ORG_ID, userId, workspaceId, role, NOW).run();
}

/** Mint a key as the owner through the real handler, returning what the response carried. */
async function mintAsOwner(): Promise<{ id: string; secret: string }> {
  const res = await call(await mint(OWNER.uid, OWNER.email), "/v1/keys", createKey, {
    method: "POST",
    body: { name: "reveal-me", ops: ["read", "list"] },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { key: { id: string }; secret: string; secretRetrievable: boolean };
  expect(body.secretRetrievable).toBe(true);
  return { id: body.key.id, secret: body.secret };
}

const reveal = (token: string, keyId: string) =>
  call(token, `/v1/keys/${keyId}/secret`, (ctx, req) => revealKey(ctx, req, keyId));

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
  // In dependency order, because D1 enforces foreign keys on DELETE. A
  // provisioned sandbox leaves a provisional user owning an organization
  // owning a workspace owning an agent; deleting the user first, as the
  // members suite can afford to, fails on the organization still pointing at
  // it. And resetBootstrapData() is the wrong tool here: it clears every
  // unclaimed workspace, which the two seeded ones are.
  await env.DB.prepare(`DELETE FROM api_keys`).run();
  await env.DB.prepare(`DELETE FROM audit_events`).run();
  await env.DB.prepare(`DELETE FROM memberships WHERE user_id != 'usr_TESTUSER'`).run();
  await env.DB.prepare(`DELETE FROM agents`).run();
  await env.DB.prepare(`DELETE FROM workspaces WHERE id NOT IN (?, ?)`).bind(WORKSPACE_A, WORKSPACE_B).run();
  await env.DB.prepare(`DELETE FROM organizations WHERE id != ?`).bind(ORG_ID).run();
  await env.DB.prepare(`DELETE FROM users WHERE id != 'usr_TESTUSER'`).run();
  await seedTwoWorkspaces();
  await seedUser(OWNER);
  await seedUser(READER);
  // The account owner's row names no workspace: it covers every one.
  await seedMembership("mem_ROWNER", OWNER.id, "owner", null);
  await seedMembership("mem_RREADER", READER.id, "reader", WORKSPACE_A);
});

describe("secretbox", () => {
  it("round-trips, and the sealed form is not the plaintext", async () => {
    const sealed = await sealSecret(SECRET, "ask_live_abc", "key_1");
    expect(sealed).not.toContain("ask_live_abc");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(await openSecret(SECRET, sealed, "key_1")).toBe("ask_live_abc");
  });

  it("opens as nothing for the wrong row, the wrong secret, or altered bytes", async () => {
    const sealed = await sealSecret(SECRET, "ask_live_abc", "key_1");

    // The associated data is the row id. A ciphertext copied into another row
    // must not reveal as that row's key.
    expect(await openSecret(SECRET, sealed, "key_2")).toBeNull();
    expect(await openSecret("some-other-secret", sealed, "key_1")).toBeNull();

    const parts = sealed.split(".");
    const flipped = `${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -2)}AA`;
    expect(await openSecret(SECRET, flipped, "key_1")).toBeNull();
    expect(await openSecret(SECRET, "v9.garbage", "key_1")).toBeNull();
  });
});

describe("GET /v1/keys/:id/secret", () => {
  it("hands the owner back exactly the token that was minted, and writes it down", async () => {
    const { id, secret } = await mintAsOwner();

    const res = await reveal(await mint(OWNER.uid, OWNER.email), id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { secret: string }).secret).toBe(secret);

    // Sealed at rest: the stored column is not the token.
    const row = await env.DB.prepare(`SELECT key_ciphertext FROM api_keys WHERE id = ?`)
      .bind(id)
      .first<{ key_ciphertext: string | null }>();
    expect(row?.key_ciphertext).not.toBeNull();
    expect(row?.key_ciphertext).not.toContain(secret);

    const audit = await env.DB.prepare(
      `SELECT actor_id, resource_id FROM audit_events WHERE action = 'key.revealed'`
    ).first<{ actor_id: string; resource_id: string }>();
    expect(audit?.actor_id).toBe(OWNER.id);
    expect(audit?.resource_id).toBe(id);
  });

  it("refuses a reader", async () => {
    const { id } = await mintAsOwner();
    const res = await reveal(await mint(READER.uid, READER.email), id);
    expect(res.status).toBe(403);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'key.revealed'`).first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it("refuses an API key, through the real router", async () => {
    const { id } = await mintAsOwner();
    // A key holding keys:create is the strongest an agent can hold, and it
    // still may not read the key beside it.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "write", "list", "delete", "keys:create"] });
    const res = await SELF.fetch(`${URL_BASE}/v1/keys/${id}/secret`, { headers: bearer(token) });
    expect(res.status).toBe(403);
  });

  it("refuses a revoked key", async () => {
    const { id } = await mintAsOwner();
    await env.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`).bind(NOW, id).run();
    const res = await reveal(await mint(OWNER.uid, OWNER.email), id);
    expect(res.status).toBe(409);
  });

  it("answers 409 for a key minted before keys were kept, and says so in the list", async () => {
    // seedApiKey writes the row the way every key was written before 0022:
    // hash only, no ciphertext.
    const { keyId: id } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read"] });
    const res = await reveal(await mint(OWNER.uid, OWNER.email), id);
    expect(res.status).toBe(409);

    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list"] });
    const list = (await (await SELF.fetch(`${URL_BASE}/v1/keys`, { headers: bearer(token) })).json()) as {
      keys: { id: string; retrievable: boolean }[];
    };
    expect(list.keys.find(k => k.id === id)?.retrievable).toBe(false);
    expect(list.keys.every(k => !("secret" in k) && !("keyCiphertext" in k))).toBe(true);
  });

  it("keeps nothing when the deployment has no secret to seal under", async () => {
    const res = await call(await mint(OWNER.uid, OWNER.email), "/v1/keys", createKey, {
      method: "POST",
      body: { name: "unsealed", ops: ["read"] },
      encryptionKey: null,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: { id: string; retrievable: boolean }; secretRetrievable: boolean };
    expect(body.secretRetrievable).toBe(false);
    expect(body.key.retrievable).toBe(false);
  });

  it("is a 404 for a key in another workspace", async () => {
    const { keyId: id } = await seedApiKey({ workspaceId: "ws_BBBBBBBBBBBBBBBBBBBBBBBBBB", ops: ["read"] });
    const res = await reveal(await mint(OWNER.uid, OWNER.email), id);
    expect(res.status).toBe(404);
  });
});

describe("sandbox provisioning", () => {
  it("seals the initial key the same way, bound to its own row", async () => {
    const result = await provisionSandboxWorkspace(env.DB, {
      workspaceName: "Sealed sandbox",
      agentName: "bot",
      now: NOW,
      encryptionKey: SECRET,
    });
    const row = await env.DB.prepare(`SELECT key_ciphertext FROM api_keys WHERE id = ?`)
      .bind(result.keyId)
      .first<{ key_ciphertext: string | null }>();
    expect(row?.key_ciphertext).not.toBeNull();
    expect(await openSecret(SECRET, row?.key_ciphertext ?? "", result.keyId)).toBe(result.token);
  });

  it("keeps nothing without a secret", async () => {
    const result = await provisionSandboxWorkspace(env.DB, {
      workspaceName: "Unsealed sandbox",
      agentName: "bot",
      now: NOW,
      encryptionKey: null,
    });
    const row = await env.DB.prepare(`SELECT key_ciphertext FROM api_keys WHERE id = ?`)
      .bind(result.keyId)
      .first<{ key_ciphertext: string | null }>();
    expect(row?.key_ciphertext).toBeNull();
  });
});
