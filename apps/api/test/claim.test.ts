/**
 * Workspace claiming: the claim link, both claim modes, and the unclaimed sweep.
 *
 * Driven as real HTTP against real provisioned state, rather than against
 * hand-built fixtures. `backlog/017` is the reason that matters here more than
 * usual: four declared limits survived a passing suite precisely because the
 * tests asserted the *shape* of a response rather than what the request path
 * actually did to a workspace with non-default numbers on it. So every quota
 * assertion below sets a real counter on a real row and then makes a real call.
 *
 * The sandbox side is provisioned by `provisionSandboxWorkspace` - the same
 * function POST /v1/workspaces calls - because it is the only thing that
 * produces a genuine claim token, and a test that wrote its own token would be
 * testing its own idea of the format.
 */

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { provisionSandboxWorkspace } from "../src/db/bootstrap";
import { expireUnclaimedWorkspaces } from "../src/jobs/sandbox-expiry";
import { SANDBOX_LIMITS, PLAN_LIMITS } from "../src/lib/plans";
import { UNCLAIMED_TTL_MS } from "../src/lib/claim";
import { objectKey } from "../src/storage/keys";
import { NOW } from "./helpers";

const URL_BASE = "https://api-dev.agentdisk.io";
const PROJECT_ID = "agentdisk-dev";
const KID = "claim-test-key";

const OWNER = "usr_CLAIMOWNER";
const OWNER_UID = "firebase-uid-claim-owner";
const OWNER_ORG = "org_CLAIMOWNED";
const TARGET_WS = "ws_TARGET00000000000000000000";

const READER = "usr_CLAIMREADER";
const READER_UID = "firebase-uid-claim-reader";

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

function asUser(token: string, body?: unknown, method = "POST"): RequestInit {
  return {
    method: body === undefined ? "GET" : method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function toBase64(value: string): string {
  return btoa(value);
}

/** A sandbox provisioned exactly as the public endpoint provisions one. */
async function provision(options: { name?: string; agent?: string; createdAt?: number } = {}) {
  const result = await provisionSandboxWorkspace(env.DB, {
    workspaceName: options.name ?? "Sandbox",
    agentName: options.agent ?? "sandbox-agent",
    now: options.createdAt ?? Date.now(),
  });
  if (options.createdAt !== undefined) {
    await env.DB.prepare(`UPDATE workspaces SET created_at = ? WHERE id = ?`)
      .bind(options.createdAt, result.workspaceId)
      .run();
  }
  return result;
}

/** A real file: a row, and real bytes at the key the row names. */
async function seedFile(
  workspaceId: string,
  agentId: string,
  path: string,
  content: string,
  sizeOverride?: number
): Promise<string> {
  const fileId = `fil_${crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase()}`;
  const key = objectKey(workspaceId, fileId);
  await env.FILES.put(key, new TextEncoder().encode(content));
  const size = sizeOverride ?? content.length;
  await env.DB.prepare(
    `INSERT INTO files
       (id, workspace_id, folder_id, name, path, r2_object_key, size_bytes, mime_type,
        checksum_sha256, caption, custom_metadata, status, created_by, created_at, updated_at, deleted_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, 'text/plain', NULL, NULL, NULL, 'active', ?, ?, ?, NULL)`
  )
    .bind(fileId, workspaceId, path.split("/").pop(), path, key, size, agentId, NOW, NOW)
    .run();
  await env.DB.prepare(
    `UPDATE workspaces SET file_count = file_count + 1, storage_bytes_used = storage_bytes_used + ?
      WHERE id = ?`
  )
    .bind(size, workspaceId)
    .run();
  return fileId;
}

async function counters(workspaceId: string) {
  return env.DB.prepare(
    `SELECT file_count, storage_bytes_used, claimed_at, org_id FROM workspaces WHERE id = ?`
  )
    .bind(workspaceId)
    .first<{
      file_count: number;
      storage_bytes_used: number;
      claimed_at: number | null;
      org_id: string;
    }>();
}

async function setUsage(workspaceId: string, bytes: number, files = 0): Promise<void> {
  await env.DB.prepare(
    `UPDATE workspaces SET storage_bytes_used = ?, file_count = ? WHERE id = ?`
  )
    .bind(bytes, files, workspaceId)
    .run();
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

beforeEach(async () => {
  await env.CACHE.put("firebase:jwks:v1", JSON.stringify({ keys: [publicJwk] }));

  // A clean slate that does not depend on what any other suite left behind.
  for (const table of [
    "file_tags",
    "files",
    "folders",
    "api_keys",
    "agents",
    "webhooks",
    "audit_events",
    "memberships",
    "workspaces",
    "organizations",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }

  await env.DB.prepare(
    `INSERT INTO users (id, email, firebase_uid, is_provisional, session_revoked_after, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, ?, ?)`
  )
    .bind(OWNER, "claimowner@example.com", OWNER_UID, NOW, NOW)
    .run();
  await env.DB.prepare(
    `INSERT INTO organizations (id, name, owner_user_id, plan, billing_status, created_at, updated_at)
     VALUES (?, ?, ?, 'free', 'active', ?, ?)`
  )
    .bind(OWNER_ORG, "Claim Owner", OWNER, NOW, NOW)
    .run();
  await env.DB.prepare(
    `INSERT INTO memberships (id, org_id, user_id, workspace_id, role, created_at)
     VALUES (?, ?, ?, NULL, 'owner', ?)`
  )
    .bind("mem_CLAIMOWNER", OWNER_ORG, OWNER, NOW)
    .run();
  await env.DB.prepare(
    `INSERT INTO workspaces
       (id, org_id, name, slug, status, period_reset_at, claimed_at, created_at, updated_at)
     VALUES (?, ?, 'Target', 'target', 'active', ?, ?, ?, ?)`
  )
    .bind(TARGET_WS, OWNER_ORG, Date.now() + 86_400_000, NOW, NOW, NOW)
    .run();

  // A reader on the target, to prove the merge refuses one.
  await env.DB.prepare(
    `INSERT INTO users (id, email, firebase_uid, is_provisional, session_revoked_after, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, ?, ?)`
  )
    .bind(READER, "claimreader@example.com", READER_UID, NOW, NOW)
    .run();
  await env.DB.prepare(
    `INSERT INTO memberships (id, org_id, user_id, workspace_id, role, created_at)
     VALUES (?, ?, ?, ?, 'reader', ?)`
  )
    .bind("mem_CLAIMREADER", OWNER_ORG, READER, TARGET_WS, NOW)
    .run();
});

describe("GET /v1/workspaces/claim/:token - the preview", () => {
  it("describes the workspace without any credential at all", async () => {
    const sandbox = await provision({ name: "Agent Scratch", agent: "researcher" });
    await seedFile(sandbox.workspaceId, sandbox.agentId, "/notes.txt", "hello");

    const res = await SELF.fetch(`${URL_BASE}/v1/workspaces/claim/${sandbox.claimToken}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      claimable: boolean;
      workspace: { id: string; name: string; fileCount: number };
      agent: { name: string } | null;
      limits: { storageBytes: number };
    };
    expect(body.claimable).toBe(true);
    expect(body.workspace.id).toBe(sandbox.workspaceId);
    expect(body.workspace.name).toBe("Agent Scratch");
    expect(body.workspace.fileCount).toBe(1);
    expect(body.agent?.name).toBe("researcher");
    // The sandbox allowance, not the free plan's - the page must not promise
    // room the next upload would refuse.
    expect(body.limits.storageBytes).toBe(SANDBOX_LIMITS.storageBytes);
  });

  it("gives one identical answer for any token that names nothing", async () => {
    const res = await SELF.fetch(`${URL_BASE}/v1/workspaces/claim/not-a-real-token`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("That claim link is not valid.");
  });

  it("stops describing the workspace once it has been claimed", async () => {
    const sandbox = await provision();
    const token = await mint(OWNER_UID, "claimowner@example.com");
    await SELF.fetch(
      `${URL_BASE}/v1/workspaces/claim/${sandbox.claimToken}`,
      asUser(token, { mode: "new" })
    );

    const res = await SELF.fetch(`${URL_BASE}/v1/workspaces/claim/${sandbox.claimToken}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.claimed).toBe(true);
    expect(body.claimable).toBe(false);
    // The name, size and contents now belong to whoever claimed it.
    expect(body.workspace).toBeUndefined();
  });
});

describe("POST /v1/workspaces/claim/:token - mode new", () => {
  it("moves the workspace onto the caller's billing account", async () => {
    const sandbox = await provision({ name: "Scratch" });
    const token = await mint(OWNER_UID, "claimowner@example.com");

    const res = await SELF.fetch(
      `${URL_BASE}/v1/workspaces/claim/${sandbox.claimToken}`,
      asUser(token, { mode: "new" })
    );
    expect(res.status).toBe(200);

    const after = await counters(sandbox.workspaceId);
    expect(after?.claimed_at).not.toBeNull();
    // Reparented, so "one real user, one owned org" still holds.
    expect(after?.org_id).toBe(OWNER_ORG);

    const provisional = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE is_provisional = 1`
    ).first<{ n: number }>();
    expect(provisional?.n).toBe(0);
  });

  it("refuses an API key - claiming is a person's act", async () => {
    const sandbox = await provision();
    const res = await SELF.fetch(`${URL_BASE}/v1/workspaces/claim/${sandbox.claimToken}`, {
      method: "POST",
      headers: { authorization: `Bearer ${sandbox.token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "new" }),
    });
    expect(res.status).toBe(401);
  });

  /**
   * The race. Both requests are in flight before either resolves, which is what
   * a double-click and two open tabs both look like from here.
   */
  it("lets exactly one of two simultaneous claims win", async () => {
    const sandbox = await provision();
    const token = await mint(OWNER_UID, "claimowner@example.com");
    const url = `${URL_BASE}/v1/workspaces/claim/${sandbox.claimToken}`;

    const [a, b] = await Promise.all([
      SELF.fetch(url, asUser(token, { mode: "new" })),
      SELF.fetch(url, asUser(token, { mode: "new" })),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = a.status === 409 ? a : b;
    const body = (await loser.json()) as { error: { message: string } };
    expect(body.error.message).toBe("This workspace has already been claimed.");
  });

  it("refuses a link whose expiry has passed", async () => {
    const sandbox = await provision();
    await env.DB.prepare(`UPDATE workspaces SET claim_token_expires_at = ? WHERE id = ?`)
      .bind(Date.now() - 1000, sandbox.workspaceId)
      .run();

    const token = await mint(OWNER_UID, "claimowner@example.com");
    const res = await SELF.fetch(
      `${URL_BASE}/v1/workspaces/claim/${sandbox.claimToken}`,
      asUser(token, { mode: "new" })
    );
    expect(res.status).toBe(409);
    expect((await res.json() as { error: { message: string } }).error.message).toBe(
      "This claim link has expired."
    );
  });
});

describe("POST /v1/workspaces/claim/:token - mode attach", () => {
  it("merges the files and repoints the agent's existing key", async () => {
    const sandbox = await provision({ agent: "researcher" });
    await seedFile(sandbox.workspaceId, sandbox.agentId, "/report.txt", "findings");
    await seedFile(sandbox.workspaceId, sandbox.agentId, "/data/raw.csv", "a,b,c");

    const token = await mint(OWNER_UID, "claimowner@example.com");
    const res = await SELF.fetch(
      `${URL_BASE}/v1/workspaces/claim/${sandbox.claimToken}`,
      asUser(token, { mode: "attach", targetWorkspaceId: TARGET_WS })
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      agent: { name: string; pathPrefix: string; keysRepointed: number };
      files: { moved: number; items: { path: string }[] };
    };
    expect(body.files.moved).toBe(2);
    expect(body.agent.pathPrefix).toBe("/agents/researcher");
    expect(body.files.items.map(f => f.path).sort()).toEqual([
      "/agents/researcher/data/raw.csv",
      "/agents/researcher/report.txt",
    ]);
    expect(body.agent.keysRepointed).toBe(1);

    // Counters updated in this operation, not left for the next sweep.
    const target = await counters(TARGET_WS);
    expect(target?.file_count).toBe(2);
    expect(target?.storage_bytes_used).toBe("findings".length + "a,b,c".length);

    // The sandbox and its provisional owner are gone.
    const gone = await counters(sandbox.workspaceId);
    expect(gone).toBeNull();
  });

  /**
   * The key's *next call*, with the same raw token it has always had. This is
   * the property the merge exists to preserve: an agent mid-run does not have
   * to re-authenticate because its owner claimed the workspace.
   */
  it("leaves the sandbox key working, now pointing at the target", async () => {
    const sandbox = await provision({ agent: "researcher" });
    await seedFile(sandbox.workspaceId, sandbox.agentId, "/report.txt", "findings");

    const token = await mint(OWNER_UID, "claimowner@example.com");
    await SELF.fetch(
      `${URL_BASE}/v1/workspaces/claim/${sandbox.claimToken}`,
      asUser(token, { mode: "attach", targetWorkspaceId: TARGET_WS })
    );

    const who = await SELF.fetch(`${URL_BASE}/v1/whoami`, {
      headers: { authorization: `Bearer ${sandbox.token}` },
    });
    expect(who.status).toBe(200);
    const identity = (await who.json()) as { workspace?: { id: string }; workspaceId?: string };
    expect(identity.workspace?.id ?? identity.workspaceId).toBe(TARGET_WS);

    // And it can still read the file it wrote, at its new path.
    const list = await SELF.fetch(`${URL_BASE}/v1/files?pathPrefix=/agents/researcher`, {
      headers: { authorization: `Bearer ${sandbox.token}` },
    });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { files: { path: string }[] };
    expect(listed.files.map(f => f.path)).toContain("/agents/researcher/report.txt");
  });

  it("suffixes a colliding agent name and loses nothing", async () => {
    // The target already has an agent by that name, and `agents` is
    // UNIQUE(workspace_id, name), so this is a hard failure if unhandled.
    await env.DB.prepare(
      `INSERT INTO agents (id, workspace_id, name, status, created_by_user_id, created_at)
       VALUES (?, ?, 'sandbox-agent', 'active', ?, ?)`
    )
      .bind("agt_EXTANT00000000000000000000", TARGET_WS, OWNER, NOW)
      .run();

    const sandbox = await provision({ agent: "sandbox-agent" });
    await seedFile(sandbox.workspaceId, sandbox.agentId, "/a.txt", "one");
    await seedFile(sandbox.workspaceId, sandbox.agentId, "/b.txt", "two");

    const token = await mint(OWNER_UID, "claimowner@example.com");
    const res = await SELF.fetch(
      `${URL_BASE}/v1/workspaces/claim/${sandbox.claimToken}`,
      asUser(token, { mode: "attach", targetWorkspaceId: TARGET_WS })
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      agent: { name: string; renamed: boolean };
      files: { moved: number };
    };
    expect(body.agent.name).toBe("sandbox-agent-2");
    expect(body.agent.renamed).toBe(true);
    expect(body.files.moved).toBe(2);

    // No data loss: both files are in the target, under the suffixed namespace.
    const rows = await env.DB.prepare(
      `SELECT path FROM files WHERE workspace_id = ? ORDER BY path`
    )
      .bind(TARGET_WS)
      .all<{ path: string }>();
    expect(rows.results.map(r => r.path)).toEqual([
      "/agents/sandbox-agent-2/a.txt",
      "/agents/sandbox-agent-2/b.txt",
    ]);
  });

  /**
   * All or nothing. A merge that took whatever fit and reported success would be
   * a false success of exactly the kind backlog/023 catalogues - and worse than
   * most, because the files it dropped were about to be deleted from the only
   * other place they existed.
   */
  it("refuses the whole merge when the target is near its cap, merging nothing", async () => {
    const sandbox = await provision();
    await seedFile(sandbox.workspaceId, sandbox.agentId, "/big.txt", "x".repeat(500));
    await seedFile(sandbox.workspaceId, sandbox.agentId, "/small.txt", "y");

    // One byte of headroom on the target's free-plan storage limit.
    await setUsage(TARGET_WS, PLAN_LIMITS.free.storageBytes - 1, 0);

    const before = await counters(TARGET_WS);
    const token = await mint(OWNER_UID, "claimowner@example.com");
    const res = await SELF.fetch(
      `${URL_BASE}/v1/workspaces/claim/${sandbox.claimToken}`,
      asUser(token, { mode: "attach", targetWorkspaceId: TARGET_WS })
    );
    expect(res.status).toBe(429);

    // Nothing partially merged: the target is untouched...
    const after = await counters(TARGET_WS);
    expect(after?.file_count).toBe(before?.file_count);
    expect(after?.storage_bytes_used).toBe(before?.storage_bytes_used);

    const targetFiles = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM files WHERE workspace_id = ?`
    )
      .bind(TARGET_WS)
      .first<{ n: number }>();
    expect(targetFiles?.n).toBe(0);

    // ...and the sandbox still holds both of its files.
    const sourceFiles = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM files WHERE workspace_id = ?`
    )
      .bind(sandbox.workspaceId)
      .first<{ n: number }>();
    expect(sourceFiles?.n).toBe(2);

    // And the claim was released, so the link still works.
    const still = await counters(sandbox.workspaceId);
    expect(still?.claimed_at).toBeNull();
  });

  it("refuses a reader on the target - a merge spends somebody else's quota", async () => {
    const sandbox = await provision();
    await seedFile(sandbox.workspaceId, sandbox.agentId, "/a.txt", "one");

    const token = await mint(READER_UID, "claimreader@example.com");
    const res = await SELF.fetch(
      `${URL_BASE}/v1/workspaces/claim/${sandbox.claimToken}`,
      asUser(token, { mode: "attach", targetWorkspaceId: TARGET_WS })
    );
    expect(res.status).toBe(404);
  });
});

describe("the sandbox quota warning", () => {
  const THRESHOLD = Math.floor(SANDBOX_LIMITS.storageBytes * 0.8);

  it("stays silent below 80% of the sandbox limit", async () => {
    const sandbox = await provision();
    await setUsage(sandbox.workspaceId, THRESHOLD - 5_000_000, 1);

    const res = await SELF.fetch(`${URL_BASE}/v1/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${sandbox.token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: "/quiet.txt", content: toBase64("12345") }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-agentdisk-quota-warning")).toBeNull();
    expect((await res.json() as Record<string, unknown>).warning).toBeUndefined();
  });

  it("warns on the write that crosses 80%, without refusing it", async () => {
    const sandbox = await provision();
    // Two bytes short of the threshold, so a five-byte write crosses it.
    await setUsage(sandbox.workspaceId, THRESHOLD - 2, 1);

    const res = await SELF.fetch(`${URL_BASE}/v1/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${sandbox.token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: "/loud.txt", content: toBase64("12345") }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-agentdisk-quota-warning")).toContain("SANDBOX_QUOTA_WARNING");

    const body = (await res.json()) as {
      warning: { code: string; dimension: string; usedPercent: number; deletesInDays: number };
    };
    expect(body.warning.code).toBe("SANDBOX_QUOTA_WARNING");
    expect(body.warning.dimension).toBe("storage");
    expect(body.warning.usedPercent).toBe(80);
    expect(body.warning.deletesInDays).toBeGreaterThan(0);
  });

  it("never warns a claimed workspace, however full it is", async () => {
    const sandbox = await provision();
    await env.DB.prepare(`UPDATE workspaces SET claimed_at = ? WHERE id = ?`)
      .bind(Date.now(), sandbox.workspaceId)
      .run();
    await setUsage(sandbox.workspaceId, PLAN_LIMITS.free.storageBytes - 10, 1);

    const res = await SELF.fetch(`${URL_BASE}/v1/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${sandbox.token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: "/claimed.txt", content: toBase64("1") }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-agentdisk-quota-warning")).toBeNull();
  });
});

/**
 * The rollout guard, as a test.
 *
 * A sandbox that predates this feature has no claim token, so it must keep the
 * free plan's limits. Without this, deploying the tighter sandbox allowance
 * would have re-tiered every unclaimed workspace already in the dev environment
 * and made every write to an over-50 MB one fail instantly.
 */
describe("the sandbox limit is not applied retroactively", () => {
  it("leaves a pre-existing unclaimed workspace on the free plan's limits", async () => {
    const sandbox = await provision();
    // Exactly what an older sandbox looks like: unclaimed, but never issued a
    // claim token, because it was created before claiming existed.
    await env.DB.prepare(
      `UPDATE workspaces
          SET claim_token_hash = NULL, claim_token_expires_at = NULL,
              storage_bytes_used = ?, file_count = 1
        WHERE id = ?`
    )
      .bind(SANDBOX_LIMITS.storageBytes * 2, sandbox.workspaceId)
      .run();

    // Well over the new sandbox cap, comfortably under the free plan's.
    const res = await SELF.fetch(`${URL_BASE}/v1/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${sandbox.token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: "/legacy.txt", content: toBase64("still fine") }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-agentdisk-quota-warning")).toBeNull();
  });

  it("does hold a newly provisioned sandbox to the tighter cap", async () => {
    const sandbox = await provision();
    await setUsage(sandbox.workspaceId, SANDBOX_LIMITS.storageBytes - 1, 1);

    const res = await SELF.fetch(`${URL_BASE}/v1/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${sandbox.token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: "/over.txt", content: toBase64("too much") }),
    });
    expect(res.status).toBe(429);
  });
});

describe("expireUnclaimedWorkspaces", () => {
  it("reports candidates and deletes nothing in its default dry-run mode", async () => {
    const now = Date.now();
    const old = await provision({ createdAt: now - UNCLAIMED_TTL_MS - 60_000 });
    await seedFile(old.workspaceId, old.agentId, "/a.txt", "data");

    const result = await expireUnclaimedWorkspaces(env.DB, env.FILES, now);

    expect(result.dryRun).toBe(true);
    expect(result.workspacesDeleted).toBe(0);
    expect(result.objectsDeleted).toBe(0);
    expect(result.candidates.map(c => c.workspaceId)).toContain(old.workspaceId);

    // The whole point: it is still there.
    expect(await counters(old.workspaceId)).not.toBeNull();
  });

  it("deletes past the TTL and spares anything inside it, once enabled", async () => {
    const now = Date.now();
    const expired = await provision({ createdAt: now - UNCLAIMED_TTL_MS - 60_000 });
    const fresh = await provision({ createdAt: now - UNCLAIMED_TTL_MS + 60_000 });
    const fileId = await seedFile(expired.workspaceId, expired.agentId, "/a.txt", "data");
    const key = objectKey(expired.workspaceId, fileId);
    expect(await env.FILES.head(key)).not.toBeNull();

    const result = await expireUnclaimedWorkspaces(
      env.DB,
      env.FILES,
      now,
      undefined,
      undefined,
      false
    );

    expect(result.dryRun).toBe(false);
    expect(result.workspacesDeleted).toBe(1);
    expect(await counters(expired.workspaceId)).toBeNull();
    // The bytes went too, not just the rows.
    expect(await env.FILES.head(key)).toBeNull();

    // Just inside the window, so it survives.
    expect(await counters(fresh.workspaceId)).not.toBeNull();
  });

  it("spares a workspace claimed between the query and the delete", async () => {
    const now = Date.now();
    const sandbox = await provision({ createdAt: now - UNCLAIMED_TTL_MS - 60_000 });
    // Claimed after it became a candidate by age, which is the race the job
    // re-checks for. Deleting this would be the one unrecoverable mistake.
    await env.DB.prepare(`UPDATE workspaces SET claimed_at = ? WHERE id = ?`)
      .bind(now, sandbox.workspaceId)
      .run();

    const result = await expireUnclaimedWorkspaces(
      env.DB,
      env.FILES,
      now,
      undefined,
      undefined,
      false
    );

    expect(result.workspacesDeleted).toBe(0);
    expect(await counters(sandbox.workspaceId)).not.toBeNull();
  });
});
