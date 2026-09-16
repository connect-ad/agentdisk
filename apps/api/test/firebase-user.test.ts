/**
 * The human half of the authorization chain, end to end through `withAuth`
 * against real D1 - 16 PART 30, Phase 1's definition of done.
 *
 * The token is signed here with a real RSA key and verified by the real
 * verifier; only Google's JWKS endpoint is stood in for. What that buys is a
 * test of the actual chain: verification, user provisioning, membership,
 * revocation, and the workspace binding a handler cannot see past.
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withAuth, type WithAuthDeps } from "../src/middleware/auth";
import { toErrorResponse } from "../src/lib/errors";
import type { JwksCache } from "../src/auth/firebase";
import { NOW, WORKSPACE_A, WORKSPACE_B, seedTwoWorkspaces } from "./helpers";

const PROJECT_ID = "agentdisk-dev";
const OTHER_PROJECT_ID = "agentdisk";
const KID = "user-test-key";

type TestJwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

let privateKey: CryptoKey;
let publicJwk: TestJwk;

const ORG_ID = "org_TESTORG";
const MEMBER_USER = "usr_OWNERPERSON";
const MEMBER_UID = "firebase-uid-member";
const INVITED_ADMIN = "usr_INVITEDADMIN";
const INVITED_ADMIN_UID = "firebase-uid-invited-admin";
const READER_USER = "usr_READERPERSON";
const READER_UID = "firebase-uid-reader";

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function segment(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

interface MintOptions {
  uid?: string;
  email?: string;
  emailVerified?: boolean;
  projectId?: string;
  /** Seconds relative to NOW. */
  iatOffset?: number;
  name?: string;
}

async function mint(options: MintOptions = {}): Promise<string> {
  const projectId = options.projectId ?? PROJECT_ID;
  const seconds = Math.floor(NOW / 1000) + (options.iatOffset ?? 0);
  const header = { alg: "RS256", kid: KID, typ: "JWT" };
  const payload = {
    iss: `https://securetoken.google.com/${projectId}`,
    aud: projectId,
    sub: options.uid ?? MEMBER_UID,
    iat: seconds,
    exp: seconds + 3600,
    email: options.email ?? "member@example.com",
    email_verified: options.emailVerified ?? true,
    name: options.name ?? "Member Person",
    firebase: { sign_in_provider: "google.com" },
  };
  const signedInput = `${segment(header)}.${segment(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signedInput)
  );
  return `${signedInput}.${b64url(new Uint8Array(signature))}`;
}

function cache(): JwksCache {
  const body = JSON.stringify({ keys: [publicJwk] });
  return {
    async get() {
      return body;
    },
    async put() {
      /* nothing to record - the key set never rotates in these tests */
    },
  };
}

function deps(overrides: Partial<WithAuthDeps> = {}): WithAuthDeps {
  return {
    db: env.DB,
    files: env.FILES,
    signing: null,
    requestId: "req_TEST",
    now: NOW,
    firebase: { cache: cache(), projectId: PROJECT_ID },
    ...overrides,
  };
}

function request(token: string, workspaceId: string | null = WORKSPACE_A): Request {
  const url =
    workspaceId === null
      ? "https://api.test/v1/whoami"
      : `https://api.test/v1/whoami?workspaceId=${workspaceId}`;
  return new Request(url, { headers: { authorization: `Bearer ${token}` } });
}

/** Echoes back what the chain resolved, so assertions look at the real context. */
const echo = async (ctx: Parameters<Parameters<typeof withAuth>[3]>[0]) =>
  new Response(
    JSON.stringify({
      kind: ctx.identity.kind,
      actorType: ctx.identity.actorType,
      workspaceId: ctx.workspaceId,
      ops: ctx.scope.ops,
      selfUserId: ctx.self?.userId ?? null,
    }),
    { status: 200 }
  );

/**
 * `withAuth` throws; the router turns that into the 05 PART 13 envelope. Doing
 * the same here keeps the test on the middleware rather than the router, while
 * still asserting the status a caller would actually see.
 */
async function run(
  token: string,
  workspaceId: string | null = WORKSPACE_A,
  overrides: Partial<WithAuthDeps> = {}
): Promise<Response> {
  try {
    return await withAuth(request(token, workspaceId), deps(overrides), { op: null }, echo);
  } catch (thrown) {
    return toErrorResponse(thrown, "req_TEST");
  }
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
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

/** Seed a user with a Firebase account attached. */
async function seedUser(id: string, email: string, uid: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, email, firebase_uid, is_provisional, session_revoked_after,
                        created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, ?, ?)`
  )
    .bind(id, email, uid, NOW, NOW)
    .run();
}

/** `workspaceId` null grants the whole billing account; a value grants one workspace. */
async function seedMembership(
  id: string,
  userId: string,
  role: string,
  workspaceId: string | null
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO memberships (id, org_id, user_id, workspace_id, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, ORG_ID, userId, workspaceId, role, NOW)
    .run();
}

beforeEach(async () => {
  await seedTwoWorkspaces();

  // Order matters: memberships point at users, workspaces and orgs; workspaces
  // point at orgs. Deleting orgs first trips the foreign keys D1 actually
  // enforces. Anything provisioned by a previous test is swept, the two seeded
  // workspaces stay.
  await env.DB.prepare(`DELETE FROM memberships WHERE user_id != 'usr_TESTUSER'`).run();
  await env.DB.prepare(`DELETE FROM workspaces WHERE id NOT IN (?, ?)`)
    .bind(WORKSPACE_A, WORKSPACE_B)
    .run();
  await env.DB.prepare(`DELETE FROM organizations WHERE id != ?`).bind(ORG_ID).run();
  await env.DB.prepare(`DELETE FROM users WHERE id != 'usr_TESTUSER'`).run();
  await env.DB.prepare(`UPDATE users SET session_revoked_after = 0`).run();

  // The owner of the billing account: one org-wide row, reaching every
  // workspace under it.
  await seedUser(MEMBER_USER, "member@example.com", MEMBER_UID);
  await seedMembership("mem_OWNER", MEMBER_USER, "owner", null);

  // Invited to workspace A only, as admin.
  await seedUser(INVITED_ADMIN, "admin@example.com", INVITED_ADMIN_UID);
  await seedMembership("mem_ADMIN_A", INVITED_ADMIN, "admin", WORKSPACE_A);

  // Invited to workspace A only, read-only.
  await seedUser(READER_USER, "reader@example.com", READER_UID);
  await seedMembership("mem_READER_A", READER_USER, "reader", WORKSPACE_A);
});

describe("a signed-in human through the chain", () => {
  it("authenticates and lands in the workspace they named", async () => {
    const res = await run(await mint());
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("firebase_user");
    expect(body.actorType).toBe("user");
    expect(body.workspaceId).toBe(WORKSPACE_A);
    expect(body.selfUserId).toBe(MEMBER_USER);
    // Every role manages files across the whole workspace (roles.ts).
    expect(body.ops).toEqual(["read", "write", "delete", "list", "keys:create"]);
  });

  it("reaches a sibling workspace in the same org", async () => {
    const body = (await (await run(await mint(), WORKSPACE_B)).json()) as { workspaceId: string };
    // Membership is held against the org, so both workspaces are in reach -
    // and the identity still carries exactly the one that was named.
    expect(body.workspaceId).toBe(WORKSPACE_B);
  });

  it("rejects a token minted by the other environment's Firebase project", async () => {
    const res = await run(await mint({ projectId: OTHER_PROJECT_ID }));
    expect(res.status).toBe(401);
  });

  it("refuses a workspace the caller has no membership in", async () => {
    await env.DB.prepare(`DELETE FROM memberships WHERE user_id = ?`).bind(MEMBER_USER).run();
    const res = await run(await mint());
    expect(res.status).toBe(403);

    // The same answer a non-existent workspace gets, so this cannot be used to
    // discover which workspace IDs are real.
    const missing = await run(await mint(), "ws_DOESNOTEXISTAAAAAAAAAAAAA");
    expect(missing.status).toBe(403);
    expect(await missing.text()).toBe(await res.clone().text().then((t) => t));
  });

  it("requires a workspace to be named, because the credential carries none", async () => {
    const res = await run(await mint(), null);
    expect(res.status).toBe(400);
  });

  it("refuses user tokens entirely when no Firebase project is configured", async () => {
    const res = await run(await mint(), WORKSPACE_A, { firebase: null });
    expect(res.status).toBe(401);
  });
});

describe("first sight of a Firebase account", () => {
  it("provisions a user, an org and an owner membership in one go", async () => {
    const token = await mint({ uid: "firebase-uid-brand-new", email: "new@example.com" });
    const res = await run(token, WORKSPACE_A);

    // No membership in the seeded org yet, so this workspace is out of reach -
    // but the identity itself now exists.
    expect(res.status).toBe(403);

    const user = await env.DB.prepare(`SELECT * FROM users WHERE firebase_uid = ?`)
      .bind("firebase-uid-brand-new")
      .first<{ id: string; email: string; is_provisional: number }>();
    expect(user).not.toBeNull();
    expect(user?.email).toBe("new@example.com");
    expect(user?.is_provisional).toBe(0);

    const membership = await env.DB.prepare(
      `SELECT role FROM memberships WHERE user_id = ?`
    )
      .bind(user?.id)
      .first<{ role: string }>();
    expect(membership?.role).toBe("owner");
  });

  it("provisions only once for the same uid", async () => {
    const token = await mint({ uid: "firebase-uid-twice", email: "twice@example.com" });
    await run(token, WORKSPACE_A);
    await run(token, WORKSPACE_A);

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE firebase_uid = ?`
    )
      .bind("firebase-uid-twice")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("claims an invited row rather than creating a second account", async () => {
    // The colleague was added to the org by email before ever signing in.
    await env.DB.prepare(
      `INSERT INTO users (id, email, is_provisional, session_revoked_after, created_at, updated_at)
       VALUES (?, ?, 1, 0, ?, ?)`
    )
      .bind("usr_INVITED", "invited@example.com", NOW, NOW)
      .run();
    await seedMembership("mem_INVITED", "usr_INVITED", "reader", WORKSPACE_A);

    const res = await run(
      await mint({ uid: "firebase-uid-invited", email: "invited@example.com" })
    );
    expect(res.status).toBe(200);

    // They arrive already holding the membership somebody granted them, on the
    // original row - not a duplicate account with the same address.
    const body = (await res.json()) as { selfUserId: string };
    expect(body.selfUserId).toBe("usr_INVITED");

    const rows = await env.DB.prepare(
      `SELECT id, is_provisional FROM users WHERE email = ?`
    )
      .bind("invited@example.com")
      .all<{ id: string; is_provisional: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.is_provisional).toBe(0);
  });

  it("will not claim an invited row on an unverified email", async () => {
    // Otherwise anyone who can type a colleague's address into a signup form
    // inherits that colleague's memberships.
    await env.DB.prepare(
      `INSERT INTO users (id, email, is_provisional, session_revoked_after, created_at, updated_at)
       VALUES (?, ?, 1, 0, ?, ?)`
    )
      .bind("usr_TARGET", "target@example.com", NOW, NOW)
      .run();
    await seedMembership("mem_TARGET", "usr_TARGET", "owner", null);

    const res = await run(
      await mint({
        uid: "firebase-uid-impostor",
        email: "target@example.com",
        emailVerified: false,
      })
    );
    // No membership was inherited, so the seeded workspace stays out of reach.
    expect(res.status).toBe(403);

    const target = await env.DB.prepare(`SELECT firebase_uid FROM users WHERE id = ?`)
      .bind("usr_TARGET")
      .first<{ firebase_uid: string | null }>();
    expect(target?.firebase_uid).toBeNull();

    // The impostor still gets an account - they are a real Firebase user - but
    // on a non-deliverable placeholder address, not the one they claimed.
    // Storing the claimed address would have collided with the row above, which
    // is a 500 whose failure mode also confirms the address is registered.
    const impostor = await env.DB.prepare(`SELECT email FROM users WHERE firebase_uid = ?`)
      .bind("firebase-uid-impostor")
      .first<{ email: string }>();
    expect(impostor?.email).toBe("firebase-uid-impostor@firebase.invalid");
  });

  it("does not hand a new account somebody else's claimed address", async () => {
    // Same collision, but with a *verified* email: the row it would collide
    // with is already claimed by another Firebase account, so linking is not
    // available either. Falls back rather than failing.
    await env.DB.prepare(
      `INSERT INTO users (id, email, firebase_uid, is_provisional, session_revoked_after,
                          created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)`
    )
      .bind("usr_INCUMBENT", "shared@example.com", "firebase-uid-incumbent", NOW, NOW)
      .run();

    await run(await mint({ uid: "firebase-uid-latecomer", email: "shared@example.com" }));

    const latecomer = await env.DB.prepare(`SELECT email FROM users WHERE firebase_uid = ?`)
      .bind("firebase-uid-latecomer")
      .first<{ email: string }>();
    expect(latecomer?.email).toBe("firebase-uid-latecomer@firebase.invalid");

    const incumbent = await env.DB.prepare(`SELECT email FROM users WHERE id = ?`)
      .bind("usr_INCUMBENT")
      .first<{ email: string }>();
    expect(incumbent?.email).toBe("shared@example.com");
  });
});

describe("log out everywhere", () => {
  it("refuses a token issued before the cutoff, and accepts one issued after", async () => {
    // A second session, still open, holding a token minted a minute ago.
    const olderToken = await mint({ iatOffset: -60 });
    expect((await run(olderToken)).status).toBe(200);

    await env.DB.prepare(`UPDATE users SET session_revoked_after = ? WHERE id = ?`)
      .bind(NOW, MEMBER_USER)
      .run();

    // That session's next request fails, which is what forces the Firebase SDK
    // to mint a fresh token.
    expect((await run(olderToken)).status).toBe(401);

    // And the token it mints - carrying a later iat - works again, with no
    // re-login. That is the whole mechanism.
    const refreshed = await mint({ iatOffset: 60 });
    expect((await run(refreshed)).status).toBe(200);
  });

  it("only revokes the user who asked", async () => {
    await seedUser("usr_OTHERPERSON", "other@example.com", "firebase-uid-other");
    await seedMembership("mem_OTHER", "usr_OTHERPERSON", "admin", WORKSPACE_A);

    await env.DB.prepare(`UPDATE users SET session_revoked_after = ? WHERE id = ?`)
      .bind(NOW + 1000, MEMBER_USER)
      .run();

    expect((await run(await mint())).status).toBe(401);
    expect(
      (await run(await mint({ uid: "firebase-uid-other", email: "other@example.com" }))).status
    ).toBe(200);
  });
});

describe("what an invitation actually grants", () => {
  const asAdmin = (workspaceId: string) =>
    mint({ uid: INVITED_ADMIN_UID, email: "admin@example.com" }).then(t => run(t, workspaceId));
  const asReader = (workspaceId: string) =>
    mint({ uid: READER_UID, email: "reader@example.com" }).then(t => run(t, workspaceId));

  it("reaches the workspace it names, and no other", async () => {
    // The point of per-workspace membership: being invited into one client's
    // workspace must not hand over the workspace next to it on the same bill.
    expect((await asAdmin(WORKSPACE_A)).status).toBe(200);
    expect((await asAdmin(WORKSPACE_B)).status).toBe(403);
  });

  it("gives the owner every workspace under their billing account", async () => {
    expect((await run(await mint(), WORKSPACE_A)).status).toBe(200);
    expect((await run(await mint(), WORKSPACE_B)).status).toBe(200);
  });

  it("gives a reader read and list, and nothing that writes", async () => {
    const body = (await (await asReader(WORKSPACE_A)).json()) as { ops: string[] };
    expect(body.ops).toEqual(["read", "list"]);
    expect(body.ops).not.toContain("write");
    expect(body.ops).not.toContain("delete");
    // keys:create matters most of all - a read-only person who can mint a key
    // could mint one with write scope and let it do what they cannot.
    expect(body.ops).not.toContain("keys:create");
  });

  it("stops a reader at the authorization step, not just in the UI", async () => {
    const token = await mint({ uid: READER_UID, email: "reader@example.com" });
    const res = await withAuth(
      request(token, WORKSPACE_A),
      deps(),
      { op: "write" },
      echo
    ).catch(thrown => toErrorResponse(thrown, "req_TEST"));
    expect(res.status).toBe(403);
  });

  it("lets an owner keep owner rights in their own workspace despite a lesser row", async () => {
    // Someone can hold both an org-wide owner row and a workspace-scoped one.
    // Being demoted inside something you own and pay for would be surprising in
    // exactly the wrong direction.
    await seedMembership("mem_SELFREADER", MEMBER_USER, "reader", WORKSPACE_A);
    const body = (await (await run(await mint(), WORKSPACE_A)).json()) as { ops: string[] };
    expect(body.ops).toContain("write");
  });
});

describe("the workspace a signup lands in", () => {
  it("creates one, so there is somewhere to put a file immediately", async () => {
    const token = await mint({ uid: "firebase-uid-lands", email: "lands@example.com" });
    await run(token, WORKSPACE_A); // provisions on the way past

    const user = await env.DB.prepare(`SELECT id FROM users WHERE firebase_uid = ?`)
      .bind("firebase-uid-lands")
      .first<{ id: string }>();

    const workspaces = await env.DB.prepare(
      `SELECT w.id, w.name, m.role, m.workspace_id
         FROM workspaces w
         JOIN memberships m ON m.org_id = w.org_id
        WHERE m.user_id = ?`
    )
      .bind(user?.id)
      .all<{ id: string; name: string; role: string; workspace_id: string | null }>();

    expect(workspaces.results).toHaveLength(1);
    expect(workspaces.results[0]?.name).toBe("My Workspace");
    expect(workspaces.results[0]?.role).toBe("owner");
    // Org-wide, so workspaces created later are covered without another row.
    expect(workspaces.results[0]?.workspace_id).toBeNull();
  });

  it("lets them straight into it", async () => {
    const token = await mint({ uid: "firebase-uid-straight", email: "straight@example.com" });
    await run(token, WORKSPACE_A);

    const user = await env.DB.prepare(`SELECT id FROM users WHERE firebase_uid = ?`)
      .bind("firebase-uid-straight")
      .first<{ id: string }>();
    const own = await env.DB.prepare(
      `SELECT w.id FROM workspaces w
         JOIN organizations o ON o.id = w.org_id
        WHERE o.owner_user_id = ?`
    )
      .bind(user?.id)
      .first<{ id: string }>();

    const res = await run(token, own?.id ?? "missing");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaceId: string; ops: string[] };
    expect(body.workspaceId).toBe(own?.id);
    expect(body.ops).toContain("write");
  });
});
