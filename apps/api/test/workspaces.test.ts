/**
 * GET and POST /v1/workspaces for a signed-in person.
 *
 * One path serving two callers is the thing worth testing here: the same URL is
 * the Turnstile-gated sandbox when nobody is signed in, and workspace creation
 * when somebody is. Every test below is really asking "did the router pick the
 * right one, and did the wrong credential get turned away".
 */

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NOW, WORKSPACE_A, seedApiKey, seedTwoWorkspaces } from "./helpers";

const URL_BASE = "https://api-dev.agentdisk.io";
const PROJECT_ID = "agentdisk-dev";
const KID = "ws-test-key";
const ORG_ID = "org_TESTORG";
const OWNER = "usr_WSOWNER";
const OWNER_UID = "firebase-uid-ws-owner";
const GUEST = "usr_WSGUEST";
const GUEST_UID = "firebase-uid-ws-guest";

type TestJwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

let privateKey: CryptoKey;
let publicJwk: TestJwk;

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function seg(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function mint(uid: string, email: string): Promise<string> {
  const seconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: KID, typ: 'JWT' };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: uid,
    iat: seconds,
    exp: seconds + 3600,
    email,
    email_verified: true,
    firebase: { sign_in_provider: 'password' },
  };
  const input = `${seg(header)}.${seg(payload)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(input)
  );
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

/**
 * The Worker reads JWKS through KV, so seeding the real cache key is what makes
 * the real verifier accept these tokens without reaching Google.
 */
async function primeJwks(): Promise<void> {
  await env.CACHE.put('firebase:jwks:v1', JSON.stringify({ keys: [publicJwk] }));
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicJwk = {
    ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey),
    kid: KID,
    alg: 'RS256',
    use: 'sig',
  };
});

beforeEach(async () => {
  await seedTwoWorkspaces();
  await primeJwks();

  await env.DB.prepare(`DELETE FROM memberships WHERE user_id != 'usr_TESTUSER'`).run();
  await env.DB.prepare(`DELETE FROM workspaces WHERE id NOT LIKE 'ws_AAA%' AND id NOT LIKE 'ws_BBB%'`).run();
  await env.DB.prepare(`DELETE FROM organizations WHERE id != ?`).bind(ORG_ID).run();
  await env.DB.prepare(`DELETE FROM users WHERE id != 'usr_TESTUSER'`).run();

  // An owner: their own billing account, plus an org-wide membership.
  await env.DB.prepare(
    `INSERT INTO users (id, email, firebase_uid, is_provisional, session_revoked_after,
                        created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?)`
  ).bind(OWNER, 'wsowner@example.com', OWNER_UID, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO organizations (id, name, owner_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind('org_WSOWNED', 'Owned', OWNER, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO memberships (id, org_id, user_id, workspace_id, role, created_at)
     VALUES (?, ?, ?, NULL, 'owner', ?)`
  ).bind('mem_WSOWNER', 'org_WSOWNED', OWNER, NOW).run();

  // A guest: invited into somebody else's workspace, owning no account.
  await env.DB.prepare(
    `INSERT INTO users (id, email, firebase_uid, is_provisional, session_revoked_after,
                        created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?)`
  ).bind(GUEST, 'wsguest@example.com', GUEST_UID, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO memberships (id, org_id, user_id, workspace_id, role, created_at)
     VALUES (?, ?, ?, ?, 'reader', ?)`
  ).bind('mem_WSGUEST', ORG_ID, GUEST, WORKSPACE_A, NOW).run();
});

function asUser(token: string, body?: unknown): RequestInit {
  return {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

describe('POST /v1/workspaces as a signed-in person', () => {
  it('creates one under their own billing account', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    const res = await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token, { name: 'Client A' }));

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: { id: string; name: string; role: string } };
    expect(body.workspace.name).toBe('Client A');
    expect(body.workspace.role).toBe('owner');

    const row = await env.DB.prepare(`SELECT org_id, status FROM workspaces WHERE id = ?`)
      .bind(body.workspace.id)
      .first<{ org_id: string; status: string }>();
    expect(row?.org_id).toBe('org_WSOWNED');
    expect(row?.status).toBe('active');
  });

  it('writes no second membership row - the org-wide one already covers it', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token, { name: 'Client B' }));

    const rows = await env.DB.prepare(`SELECT workspace_id FROM memberships WHERE user_id = ?`)
      .bind(OWNER)
      .all<{ workspace_id: string | null }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.workspace_id).toBeNull();
  });

  it('the new workspace is immediately usable', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    const created = (await (
      await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token, { name: 'Fresh' }))
    ).json()) as { workspace: { id: string } };

    const res = await SELF.fetch(
      `${URL_BASE}/v1/whoami?workspaceId=${created.workspace.id}`,
      asUser(token)
    );
    expect(res.status).toBe(200);
  });

  it('refuses somebody who owns no billing account', async () => {
    const token = await mint(GUEST_UID, 'wsguest@example.com');
    const res = await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token, { name: 'Nope' }));
    expect(res.status).toBe(403);
  });

  it('rejects an empty or oversized name', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    for (const name of ['', '   ', 'x'.repeat(61)]) {
      const res = await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token, { name }));
      expect(res.status).toBe(400);
    }
  });

  it('will not let an agent key mint sibling workspaces', async () => {
    // A key is bound to one workspace for its whole life. Creating more from it
    // would be an escape from exactly that binding.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ['write', 'keys:create'] });
    const res = await SELF.fetch(`${URL_BASE}/v1/workspaces`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sneaky' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/workspaces', () => {
  it('lists what the caller can actually reach', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token, { name: 'One' }));
    await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token, { name: 'Two' }));

    const body = (await (
      await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token))
    ).json()) as { workspaces: { name: string; role: string }[] };

    expect(body.workspaces.map(w => w.name).sort()).toEqual(['One', 'Two']);
    // Not the seeded org's workspaces, which belong to somebody else.
    expect(body.workspaces.every(w => w.role === 'owner')).toBe(true);
  });

  it('shows a guest only the workspace they were invited to', async () => {
    const token = await mint(GUEST_UID, 'wsguest@example.com');
    const body = (await (
      await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token))
    ).json()) as { workspaces: { id: string; role: string }[] };

    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]?.id).toBe(WORKSPACE_A);
    expect(body.workspaces[0]?.role).toBe('reader');
  });

  it('refuses an unauthenticated caller the same way an invalid token is refused', async () => {
    // This used to be a 404 "No such route.", which was the one route in the
    // API that answered "you did not authenticate" with "that URL does not
    // exist". Both shapes below are the same condition from the caller's side,
    // so they get the same status and the same code.
    const missing = await SELF.fetch(`${URL_BASE}/v1/workspaces`);
    const invalid = await SELF.fetch(`${URL_BASE}/v1/workspaces`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(await errorCode(missing)).toBe(await errorCode(invalid));
  });

  it('refuses an agent key rather than pretending the route is absent', async () => {
    // A key is bound to one workspace; enumerating the account's others is
    // outside what it is for. Refused as 401, not 404, for the same reason.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ['list', 'read'] });
    const res = await SELF.fetch(`${URL_BASE}/v1/workspaces`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});

/* ------------------------ DELETE /v1/workspaces/:id ----------------------- */

/**
 * The most destructive thing this API can do, so the tests are mostly about the
 * gates rather than the deletion: who is refused, and that a refusal really
 * leaves the workspace standing. The cascade test exists for a different
 * reason — `folders.parent_folder_id` references itself and `files.folder_id`
 * points into the same subtree, which is the shape that fails whichever order a
 * single DELETE is written in.
 */

function asDelete(token: string, body: unknown): RequestInit {
  return {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Two workspaces under the owner's account, so deleting one is ever allowed. */
async function twoOwned(token: string): Promise<{ keep: string; doomed: string }> {
  const keep = (await (
    await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token, { name: 'Keep' }))
  ).json()) as { workspace: { id: string } };
  const doomed = (await (
    await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token, { name: 'Doomed' }))
  ).json()) as { workspace: { id: string } };
  return { keep: keep.workspace.id, doomed: doomed.workspace.id };
}

/** Fill a workspace with one of everything that points at it. */
async function fill(workspaceId: string): Promise<void> {
  await env.FILES.put(`ws/${workspaceId}/file_DOOMED`, 'bytes');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO folders (id, workspace_id, parent_folder_id, name, path, created_by, created_at)
       VALUES ('fld_ROOT', ?, NULL, 'docs', '/docs', ?, ?)`
    ).bind(workspaceId, OWNER, NOW),
    // A child folder, so the self-referencing parent_folder_id is really exercised.
    env.DB.prepare(
      `INSERT INTO folders (id, workspace_id, parent_folder_id, name, path, created_by, created_at)
       VALUES ('fld_CHILD', ?, 'fld_ROOT', 'sub', '/docs/sub', ?, ?)`
    ).bind(workspaceId, OWNER, NOW),
    env.DB.prepare(
      `INSERT INTO files (id, workspace_id, folder_id, name, path, r2_object_key, size_bytes,
                          mime_type, status, created_by, created_at, updated_at)
       VALUES ('file_DOOMED', ?, 'fld_CHILD', 'a.txt', '/docs/sub/a.txt', ?, 5,
               'text/plain', 'active', ?, ?, ?)`
    ).bind(workspaceId, `ws/${workspaceId}/file_DOOMED`, OWNER, NOW, NOW),
    env.DB.prepare(`INSERT INTO file_tags (file_id, tag) VALUES ('file_DOOMED', 'draft')`),
    env.DB.prepare(
      `INSERT INTO agents (id, workspace_id, name, status, created_by_user_id, created_at)
       VALUES ('agt_DOOMED', ?, 'bot', 'active', ?, ?)`
    ).bind(workspaceId, OWNER, NOW),
    env.DB.prepare(
      `INSERT INTO api_keys (id, workspace_id, agent_id, name, key_prefix, key_last_four,
                             key_hash, scopes, created_by_user_id, created_at)
       VALUES ('key_DOOMED', ?, 'agt_DOOMED', 'k', 'ad_live_x', 'abcd', 'hash_DOOMED',
               '{"ops":["read"],"pathPrefix":"/*"}', ?, ?)`
    ).bind(workspaceId, OWNER, NOW),
    env.DB.prepare(
      `INSERT INTO webhooks (id, workspace_id, url, secret, events, created_at)
       VALUES ('wh_DOOMED', ?, 'https://example.com/h', 'enc', '["file.created"]', ?)`
    ).bind(workspaceId, NOW),
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_type, actor_id, action, result, created_at)
       VALUES ('aud_DOOMED', ?, 'user', ?, 'file.upload', 'success', ?)`
    ).bind(workspaceId, OWNER, NOW),
    env.DB.prepare(
      `INSERT INTO memberships (id, org_id, user_id, workspace_id, role, created_at)
       VALUES ('mem_DOOMED', 'org_WSOWNED', ?, ?, 'reader', ?)`
    ).bind(GUEST, workspaceId, NOW),
  ]);
}

async function countIn(table: string, workspaceId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`)
    .bind(workspaceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string }; code?: string };
  return body.error?.code ?? body.code ?? '';
}

describe('DELETE /v1/workspaces/:id', () => {
  it('deletes a workspace the caller owns', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    const { doomed } = await twoOwned(token);

    const res = await SELF.fetch(`${URL_BASE}/v1/workspaces/${doomed}`, asDelete(token, { name: 'Doomed' }));
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(`SELECT id FROM workspaces WHERE id = ?`).bind(doomed).first();
    expect(row).toBeNull();
  });

  it('takes every row that pointed at it, and the R2 objects too', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    const { doomed } = await twoOwned(token);
    await fill(doomed);

    const res = await SELF.fetch(`${URL_BASE}/v1/workspaces/${doomed}`, asDelete(token, { name: 'Doomed' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: true, files: 1 });

    for (const table of ['files', 'folders', 'agents', 'api_keys', 'webhooks', 'audit_events', 'memberships']) {
      expect(await countIn(table, doomed)).toBe(0);
    }
    const tag = await env.DB.prepare(`SELECT tag FROM file_tags WHERE file_id = 'file_DOOMED'`).first();
    expect(tag).toBeNull();
    expect(await env.FILES.get(`ws/${doomed}/file_DOOMED`)).toBeNull();
  });

  it('leaves the sibling workspace and the org-wide membership alone', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    const { keep, doomed } = await twoOwned(token);
    await fill(doomed);

    await SELF.fetch(`${URL_BASE}/v1/workspaces/${doomed}`, asDelete(token, { name: 'Doomed' }));

    const kept = await env.DB.prepare(`SELECT id FROM workspaces WHERE id = ?`).bind(keep).first();
    expect(kept).not.toBeNull();
    // The owner's membership names no workspace, so it grants the rest of the
    // account and must survive one workspace being destroyed.
    const orgWide = await env.DB.prepare(
      `SELECT id FROM memberships WHERE user_id = ? AND workspace_id IS NULL`
    ).bind(OWNER).first();
    expect(orgWide).not.toBeNull();
  });

  it('refuses to leave the caller with no workspace at all', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    const only = (await (
      await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token, { name: 'Solo' }))
    ).json()) as { workspace: { id: string } };

    const res = await SELF.fetch(
      `${URL_BASE}/v1/workspaces/${only.workspace.id}`,
      asDelete(token, { name: 'Solo' })
    );
    expect(res.status).toBe(409);
    const row = await env.DB.prepare(`SELECT id FROM workspaces WHERE id = ?`)
      .bind(only.workspace.id).first();
    expect(row).not.toBeNull();
  });

  it('refuses a name that does not match, and changes nothing', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    const { doomed } = await twoOwned(token);

    const res = await SELF.fetch(`${URL_BASE}/v1/workspaces/${doomed}`, asDelete(token, { name: 'Doomd' }));
    expect(res.status).toBe(400);
    const row = await env.DB.prepare(`SELECT id FROM workspaces WHERE id = ?`).bind(doomed).first();
    expect(row).not.toBeNull();
  });

  it('refuses a body with no name at all', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    const { doomed } = await twoOwned(token);
    const res = await SELF.fetch(`${URL_BASE}/v1/workspaces/${doomed}`, asDelete(token, {}));
    expect(res.status).toBe(400);
    const row = await env.DB.prepare(`SELECT id FROM workspaces WHERE id = ?`).bind(doomed).first();
    expect(row).not.toBeNull();
  });

  it('refuses an API key, whatever its scope', async () => {
    const { token } = await seedApiKey({
      workspaceId: WORKSPACE_A,
      ops: ['read', 'list', 'write', 'delete'],
    });
    const res = await SELF.fetch(
      `${URL_BASE}/v1/workspaces/${WORKSPACE_A}`,
      asDelete(token, { name: 'Workspace A' })
    );
    expect(res.status).toBe(401);
    const row = await env.DB.prepare(`SELECT id FROM workspaces WHERE id = ?`).bind(WORKSPACE_A).first();
    expect(row).not.toBeNull();
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await SELF.fetch(`${URL_BASE}/v1/workspaces/${WORKSPACE_A}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Workspace A' }),
    });
    expect(res.status).toBe(401);
  });

  it('will not let a member delete a workspace they only belong to', async () => {
    // The guest is a reader on WORKSPACE_A and owns no billing account.
    const token = await mint(GUEST_UID, 'wsguest@example.com');
    const res = await SELF.fetch(
      `${URL_BASE}/v1/workspaces/${WORKSPACE_A}`,
      asDelete(token, { name: 'Workspace A' })
    );
    expect(res.status).toBe(404);
    const row = await env.DB.prepare(`SELECT id FROM workspaces WHERE id = ?`).bind(WORKSPACE_A).first();
    expect(row).not.toBeNull();
  });

  it('answers for somebody else real workspace exactly as for an invented one', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    await twoOwned(token);

    // WORKSPACE_A exists and belongs to a different account. Saying so would be
    // an oracle for other people's workspace IDs.
    const real = await SELF.fetch(
      `${URL_BASE}/v1/workspaces/${WORKSPACE_A}`,
      asDelete(token, { name: 'Workspace A' })
    );
    const invented = await SELF.fetch(
      `${URL_BASE}/v1/workspaces/ws_00000000000000000000000000`,
      asDelete(token, { name: 'Workspace A' })
    );
    expect(real.status).toBe(404);
    expect(invented.status).toBe(404);
    expect(await errorCode(real)).toBe(await errorCode(invented));
  });
});

/**
 * The slug travels with the workspace on both routes the dashboard reads.
 *
 * These are HTTP-level on purpose: `slug.test.ts` already proves the generator,
 * so what is left to get wrong is the wiring - a slug computed and then not
 * returned is exactly as broken as no slug at all, and is invisible to a unit
 * test of the function that computed it.
 */
describe('workspace slugs over HTTP', () => {
  it('creates one from the name and returns it', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    const res = await SELF.fetch(
      `${URL_BASE}/v1/workspaces`,
      asUser(token, { name: 'Client One' })
    );

    const body = (await res.json()) as { workspace: { id: string; slug: string } };
    expect(body.workspace.slug).toBe('client-one');

    const row = await env.DB.prepare(`SELECT slug FROM workspaces WHERE id = ?`)
      .bind(body.workspace.id)
      .first<{ slug: string }>();
    expect(row?.slug).toBe('client-one');
  });

  it('suffixes the second workspace with the same name', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    const first = (await (
      await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token, { name: 'Repeat' }))
    ).json()) as { workspace: { slug: string } };
    const second = (await (
      await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token, { name: 'Repeat' }))
    ).json()) as { workspace: { slug: string } };

    expect(first.workspace.slug).toBe('repeat');
    expect(second.workspace.slug).toBe('repeat-2');
  });

  it('lists the slug beside the ID, never instead of it', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token, { name: 'Listed Here' }));

    const body = (await (
      await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token))
    ).json()) as { workspaces: { id: string; slug: string; name: string }[] };

    const listed = body.workspaces.find(w => w.name === 'Listed Here');
    expect(listed?.slug).toBe('listed-here');
    // The real identifier is still what the API hands back. Settings shows it,
    // MCP config snippets carry it, and every other route takes it.
    expect(listed?.id).toMatch(/^ws_/);
  });

  it('gives a workspace named like an ID a slug that cannot be confused for one', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    const body = (await (
      await SELF.fetch(
        `${URL_BASE}/v1/workspaces`,
        asUser(token, { name: 'ws_01K4M9XQ2R8T7VBNJH3ZC5D6EF' })
      )
    ).json()) as { workspace: { slug: string } };

    expect(body.workspace.slug).not.toMatch(/^ws_/);
    expect(body.workspace.slug).toBe('ws-01k4m9xq2r8t7vbnjh3zc5d6ef');
  });

  it('frees the slug again when the workspace is deleted', async () => {
    const token = await mint(OWNER_UID, 'wsowner@example.com');
    await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token, { name: 'Keeper' }));
    const doomed = (await (
      await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token, { name: 'Recycled' }))
    ).json()) as { workspace: { id: string; slug: string } };
    expect(doomed.workspace.slug).toBe('recycled');

    await SELF.fetch(
      `${URL_BASE}/v1/workspaces/${doomed.workspace.id}`,
      asDelete(token, { name: 'Recycled' })
    );

    const again = (await (
      await SELF.fetch(`${URL_BASE}/v1/workspaces`, asUser(token, { name: 'Recycled' }))
    ).json()) as { workspace: { slug: string } };
    // Not `recycled-2`: nothing holds the plain one any more, and handing out an
    // ever-climbing suffix for a name nobody is using would be a leak of history.
    expect(again.workspace.slug).toBe('recycled');
  });
});
