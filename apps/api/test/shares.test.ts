import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SHARE_TTL_MS,
  MAX_SHARE_TTL_MS,
  mintShareToken,
  pathIsInside,
  resolveExpiry,
  shareUrl,
} from "../src/lib/shares";
import { WorkspaceScopedShares, findShareByToken } from "../src/db/shares";
import {
  WORKSPACE_A,
  WORKSPACE_B,
  bearer,
  resetTenantData,
  seedApiKey,
  seedTwoWorkspaces,
  setWorkspaceStatus,
} from "./helpers";
import { newId } from "../src/lib/ids";
import { purgeExpiredShares } from "../src/jobs/purge";
import { asAdmin } from "./admin-auth";

const NOW = 1_780_000_000_000;
const URL_BASE = "https://api-test.agentdisk.io";

interface ErrorBody {
  error: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
}

async function call(
  method: string,
  path: string,
  token: string,
  body?: unknown
): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      ...bearer(token),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("resolveExpiry", () => {
  it("defaults to seven days", () => {
    expect(resolveExpiry(undefined, NOW)).toBe(NOW + DEFAULT_SHARE_TTL_MS);
  });

  it("accepts a date inside the cap", () => {
    const requested = NOW + 60 * 60 * 1000;
    expect(resolveExpiry(requested, NOW)).toBe(requested);
  });

  it("refuses a date beyond the cap", () => {
    expect(() => resolveExpiry(NOW + MAX_SHARE_TTL_MS + 120_000, NOW)).toThrow(/7 days/);
  });

  it("accepts the exact ceiling, because a caller cannot see our clock", () => {
    // The defect this exists to stop. `ctx.now` is captured before any I/O and
    // a Workers clock only advances on I/O, so it can read the previous
    // request's time - which made "seven days from now" refused for being
    // honest. A caller slightly ahead of us is inside the grace.
    expect(() => resolveExpiry(NOW + MAX_SHARE_TTL_MS, NOW)).not.toThrow();
    expect(() => resolveExpiry(NOW + MAX_SHARE_TTL_MS + 30_000, NOW)).not.toThrow();
  });

  it("never grants more than the cap, whatever the grace let through", () => {
    // The grace decides what is accepted, not what is granted.
    expect(resolveExpiry(NOW + MAX_SHARE_TTL_MS + 30_000, NOW)).toBe(NOW + MAX_SHARE_TTL_MS);
  });

  it("refuses a date in the past", () => {
    expect(() => resolveExpiry(NOW - 1000, NOW)).toThrow(/future/);
  });
});

describe("pathIsInside", () => {
  it("accepts a direct child", () => {
    expect(pathIsInside("/reports/q3.pdf", "/reports")).toBe(true);
  });

  it("accepts a nested descendant, because folder shares are recursive", () => {
    expect(pathIsInside("/reports/draft/notes.md", "/reports")).toBe(true);
  });

  it("refuses a sibling whose name merely starts the same way", () => {
    // The whole bug class. A plain startsWith says this is inside /reports.
    expect(pathIsInside("/reports-private/secrets.md", "/reports")).toBe(false);
  });

  it("refuses the folder itself", () => {
    expect(pathIsInside("/reports", "/reports")).toBe(false);
  });

  it("treats the empty prefix as the whole workspace", () => {
    expect(pathIsInside("/anything.md", "")).toBe(true);
  });
});

describe("mintShareToken", () => {
  it("returns a token and its hash, and never the same token twice", async () => {
    const a = await mintShareToken();
    const b = await mintShareToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[0-9A-Za-z]{32}$/);
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("shareUrl", () => {
  it("builds the dashboard link", () => {
    expect(shareUrl("https://app.example.com/", "abc")).toBe("https://app.example.com/s/abc");
  });

  it("returns null when no dashboard is configured", () => {
    expect(shareUrl(undefined, "abc")).toBeNull();
  });
});

/**
 * `r2_object_key` and `mime_type` are NOT NULL with no default, so a seed that
 * omits them fails on the constraint rather than on the thing under test.
 * Nothing here reads either column; they are present to satisfy the schema.
 */
async function seedFile(id: string, path: string, workspaceId = WORKSPACE_A): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO files
       (id, workspace_id, path, name, r2_object_key, mime_type, status,
        size_bytes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'text/markdown', 'active', 7, 'usr_TESTUSER', ?, ?)`
  )
    .bind(id, workspaceId, path, path.split("/").pop(), `${workspaceId}/${id}`, NOW, NOW)
    .run();
}

describe("WorkspaceScopedShares", () => {
  beforeEach(async () => {
    await seedTwoWorkspaces();
    await resetTenantData();
  });

  it("counts only links that have not expired", async () => {
    const shares = new WorkspaceScopedShares(env.DB, WORKSPACE_A);
    await seedFile("fil_LIVE", "/live.md");
    await seedFile("fil_DEAD", "/dead.md");

    await shares.create({
      id: "shr_LIVE", kind: "file", fileId: "fil_LIVE", folderPath: null,
      token: "tokenlive", tokenHash: "hashlive",
      expiresAt: NOW + 1000, createdBy: "usr_TESTUSER", now: NOW,
    });
    await shares.create({
      id: "shr_DEAD", kind: "file", fileId: "fil_DEAD", folderPath: null,
      token: "tokendead", tokenHash: "hashdead",
      expiresAt: NOW - 1000, createdBy: "usr_TESTUSER", now: NOW,
    });

    expect(await shares.countLive(NOW)).toBe(1);
  });

  it("does not see another workspace's links", async () => {
    await seedFile("fil_OTHER", "/other.md", WORKSPACE_B);
    await new WorkspaceScopedShares(env.DB, WORKSPACE_B).create({
      id: "shr_OTHER", kind: "file", fileId: "fil_OTHER", folderPath: null,
      token: "tokenother", tokenHash: "hashother",
      expiresAt: NOW + 1000, createdBy: "usr_TESTUSER", now: NOW,
    });

    expect(await new WorkspaceScopedShares(env.DB, WORKSPACE_A).countLive(NOW)).toBe(0);
  });

  it("refuses to delete a link belonging to another workspace", async () => {
    await seedFile("fil_OTHER2", "/other2.md", WORKSPACE_B);
    await new WorkspaceScopedShares(env.DB, WORKSPACE_B).create({
      id: "shr_OTHER2", kind: "file", fileId: "fil_OTHER2", folderPath: null,
      token: "t2", tokenHash: "h2",
      expiresAt: NOW + 1000, createdBy: "usr_TESTUSER", now: NOW,
    });

    const deleted = await new WorkspaceScopedShares(env.DB, WORKSPACE_A).deleteById("shr_OTHER2");
    expect(deleted).toBe(false);
  });

  it("resolves a live token and refuses an expired one", async () => {
    await seedFile("fil_T", "/t.md");
    await new WorkspaceScopedShares(env.DB, WORKSPACE_A).create({
      id: "shr_T", kind: "file", fileId: "fil_T", folderPath: null,
      token: "tok", tokenHash: "hashtok",
      expiresAt: NOW + 1000, createdBy: "usr_TESTUSER", now: NOW,
    });

    expect(await findShareByToken(env.DB, "hashtok", NOW)).not.toBeNull();
    expect(await findShareByToken(env.DB, "hashtok", NOW + 2000)).toBeNull();
    expect(await findShareByToken(env.DB, "nosuchhash", NOW)).toBeNull();
  });

  it("loses the link when the file is purged, via the cascade", async () => {
    await seedFile("fil_C", "/c.md");
    await new WorkspaceScopedShares(env.DB, WORKSPACE_A).create({
      id: "shr_C", kind: "file", fileId: "fil_C", folderPath: null,
      token: "tokc", tokenHash: "hashc",
      expiresAt: NOW + 1000, createdBy: "usr_TESTUSER", now: NOW,
    });

    await env.DB.prepare(`DELETE FROM files WHERE id = ?`).bind("fil_C").run();

    expect(await findShareByToken(env.DB, "hashc", NOW)).toBeNull();
  });
});

describe("POST /v1/shares", () => {
  beforeEach(async () => {
    await seedTwoWorkspaces();
    await resetTenantData();
    await setWorkspaceStatus(WORKSPACE_A, "active");
  });

  async function setPlan(plan: string): Promise<void> {
    await env.DB.prepare(`UPDATE organizations SET plan = ? WHERE id = 'org_TESTORG'`)
      .bind(plan)
      .run();
  }

  it("refuses a key that does not carry the share op", async () => {
    const { token } = await seedApiKey({ ops: ["read", "write", "list"] });
    const res = await call("POST", "/v1/shares", token, { fileId: "fil_X" });
    expect(res.status).toBe(403);
  });

  it("refuses the free plan with a message naming the limit", async () => {
    await setPlan("free");
    const { token } = await seedApiKey({ ops: ["read", "share"] });
    await seedFile("fil_FREE", "/free.md");

    const res = await call("POST", "/v1/shares", token, { fileId: "fil_FREE" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.message).toMatch(/upgrade/i);
  });

  it("creates a link on a paid plan and returns the url exactly once", async () => {
    await setPlan("pro");
    const { token } = await seedApiKey({ ops: ["read", "share"] });
    await seedFile("fil_OK", "/ok.md");

    const res = await call("POST", "/v1/shares", token, { fileId: "fil_OK" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { share: { id: string }; url: string };
    expect(body.url).toMatch(/\/s\//);
    expect(body.share.id).toMatch(/^shr_/);
  });

  it("refuses to share a file in another workspace", async () => {
    await setPlan("pro");
    const { token } = await seedApiKey({ ops: ["read", "share"] });
    await seedFile("fil_B", "/b.md", WORKSPACE_B);

    const res = await call("POST", "/v1/shares", token, { fileId: "fil_B" });
    expect(res.status).toBe(404);
  });

  it("stops at the plan's ceiling and frees a slot when one is revoked", async () => {
    await setPlan("basic");
    const { token } = await seedApiKey({ ops: ["read", "share", "list"] });

    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      await seedFile(`fil_N${i}`, `/n${i}.md`);
      const res = await call("POST", "/v1/shares", token, { fileId: `fil_N${i}` });
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { share: { id: string } }).share.id);
    }

    await seedFile("fil_OVER", "/over.md");
    expect((await call("POST", "/v1/shares", token, { fileId: "fil_OVER" })).status).toBe(403);

    expect((await call("DELETE", `/v1/shares/${ids[0]}`, token)).status).toBe(200);
    expect((await call("POST", "/v1/shares", token, { fileId: "fil_OVER" })).status).toBe(201);
  });

  it("lists the workspace's live links", async () => {
    await setPlan("pro");
    const { token } = await seedApiKey({ ops: ["read", "share", "list"] });
    await seedFile("fil_L", "/l.md");
    await call("POST", "/v1/shares", token, { fileId: "fil_L" });

    const res = await call("GET", "/v1/shares", token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { shares: unknown[] }).shares).toHaveLength(1);
  });
});

async function publicGet(path: string): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${path}`); // no Authorization header at all
}

/** Read the body once — a Response body cannot be consumed twice. */
async function refusal(path: string): Promise<{ status: number; code: string; message: string }> {
  const res = await publicGet(path);
  const body = (await res.json()) as ErrorBody;
  return { status: res.status, code: body.error.code, message: body.error.message };
}

/**
 * Mint a share through the real authenticated route, then read the raw token
 * straight out of D1.
 *
 * Parsing it out of the returned `url` would make every test here depend on
 * DASHBOARD_URL being set in the test environment, which is configuration
 * rather than anything under test.
 */
async function tokenOf(shareId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT token FROM share_links WHERE id = ?`)
    .bind(shareId)
    .first<{ token: string }>();
  return row?.token as string;
}

async function mint(body: Record<string, unknown>): Promise<string> {
  const { token } = await seedApiKey({ ops: ["read", "share"] });
  const res = await call("POST", "/v1/shares", token, body);
  expect(res.status).toBe(201);
  return tokenOf(((await res.json()) as { share: { id: string } }).share.id);
}

async function seedLiveFileShare(path: string, fileId = `fil_${path.length}X`): Promise<string> {
  await seedFile(fileId, path);
  return mint({ fileId });
}

async function seedLiveFolderShare(path: string): Promise<string> {
  return mint({ path });
}

describe("the public share routes", () => {
  const NOTHING = 404;

  beforeEach(async () => {
    await seedTwoWorkspaces();
    await resetTenantData();
    await setWorkspaceStatus(WORKSPACE_A, "active");
    await env.DB.prepare(`UPDATE organizations SET plan = 'pro' WHERE id = 'org_TESTORG'`).run();
  });

  it("answers identically for expired, revoked and never-existed tokens", async () => {
    // Three different causes, one of them a token that was real until a moment
    // ago. If any of these three differ, the route is an oracle that confirms
    // which guesses are real tokens.
    const expiredToken = await seedLiveFileShare("/expired.md", "fil_EXPIRED");
    await env.DB.prepare(`UPDATE share_links SET expires_at = ? WHERE token = ?`)
      .bind(NOW - 1, expiredToken)
      .run();

    const revokedToken = await seedLiveFileShare("/revoked.md", "fil_REVOKED");
    await env.DB.prepare(`DELETE FROM share_links WHERE token = ?`).bind(revokedToken).run();

    const expired = await refusal(`/v1/shares/open/${expiredToken}`);
    const revoked = await refusal(`/v1/shares/open/${revokedToken}`);
    const never = await refusal("/v1/shares/open/neverexistedatall");

    expect(expired).toEqual(never);
    expect(revoked).toEqual(never);
    expect(never.status).toBe(NOTHING);
  });

  it("previews a live file share with no credential", async () => {
    const token = await seedLiveFileShare("/preview.md", "fil_PREVIEW");
    const res = await publicGet(`/v1/shares/open/${token}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; files: { id: string; name: string }[] };
    expect(body.kind).toBe("file");
    expect(body.files[0]?.name).toBe("preview.md");
  });

  it("serves nothing the moment the shared file is marked deleted", async () => {
    // The marker is the first of a delete's three steps, and it has to be
    // enough on its own: between it and the row going, a share link must not
    // still be handing the file out.
    const token = await seedLiveFileShare("/soft.md", "fil_SOFT");
    await env.DB.prepare(`UPDATE files SET status = 'deleted', deleted_at = ? WHERE id = ?`)
      .bind(NOW, "fil_SOFT")
      .run();
    expect((await publicGet(`/v1/shares/open/${token}`)).status).toBe(NOTHING);
  });

  it("takes its own share links with the file, rather than leaving them dangling", async () => {
    // share_links.file_id carries ON DELETE CASCADE, which is the whole answer
    // here: a destroyed file's links must not outlive it pointing at nothing.
    const token = await seedLiveFileShare("/hard.md", "fil_HARD");
    expect((await publicGet(`/v1/shares/open/${token}`)).status).toBe(200);

    await env.DB.prepare(`DELETE FROM file_tags WHERE file_id = ?`).bind("fil_HARD").run();
    await env.DB.prepare(`DELETE FROM files WHERE id = ?`).bind("fil_HARD").run();

    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM share_links WHERE file_id = ?`)
      .bind("fil_HARD")
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect((await publicGet(`/v1/shares/open/${token}`)).status).toBe(NOTHING);
  });

  it("refuses a sibling folder that merely shares a name prefix", async () => {
    const token = await seedLiveFolderShare("/reports");
    await seedFile("fil_EVIL", "/reports-private/secrets.md");

    const res = await publicGet(`/v1/shares/open/${token}/download/fil_EVIL`);
    expect(res.status).toBe(NOTHING);
  });

  it("refuses a file id from another workspace", async () => {
    const token = await seedLiveFolderShare("/reports");
    await seedFile("fil_OTHERWS", "/reports/x.md", WORKSPACE_B);

    expect((await publicGet(`/v1/shares/open/${token}/download/fil_OTHERWS`)).status).toBe(NOTHING);
  });

  it("refuses a file id that is not the one a file share names", async () => {
    const token = await seedLiveFileShare("/only.md", "fil_ONLY");
    await seedFile("fil_NOTSHARED", "/notshared.md");

    expect((await publicGet(`/v1/shares/open/${token}/download/fil_NOTSHARED`)).status).toBe(
      NOTHING
    );
  });

  it("serves nothing when the workspace is suspended", async () => {
    const token = await seedLiveFileShare("/susp.md", "fil_SUSP");
    await setWorkspaceStatus(WORKSPACE_A, "suspended");
    expect((await publicGet(`/v1/shares/open/${token}`)).status).toBe(NOTHING);
  });
});

describe("links die with the account and the workspace", () => {
  const ADMIN_USER_ID = "usr_TESTUSER";
  const ADMIN_USER_EMAIL = "test@example.com";

  beforeEach(async () => {
    await seedTwoWorkspaces();
    await resetTenantData();
    await setWorkspaceStatus(WORKSPACE_A, "active");
    // resetTenantData() does not touch `users` - a prior test in this block
    // that soft-deletes usr_TESTUSER would otherwise leave every later test
    // in the block operating on an already-deleted account.
    await env.DB
      .prepare(`UPDATE users SET deleted_at = NULL, disabled_at = NULL, session_revoked_after = 0 WHERE id = ?`)
      .bind(ADMIN_USER_ID)
      .run();
  });

  async function publicGet(path: string): Promise<Response> {
    return SELF.fetch(`${URL_BASE}${path}`); // no Authorization header at all
  }

  async function countShareRows(): Promise<number> {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM share_links`).first<{ n: number }>();
    return row?.n ?? 0;
  }

  async function auditReasonFor(workspaceId: string, action: string): Promise<string | null> {
    const row = await env.DB
      .prepare(
        `SELECT metadata FROM audit_events
          WHERE workspace_id = ? AND action = ?
          ORDER BY created_at DESC LIMIT 1`
      )
      .bind(workspaceId, action)
      .first<{ metadata: string }>();
    if (row === null) return null;
    return (JSON.parse(row.metadata) as { reason?: string }).reason ?? null;
  }

  /** Calls the real admin route, not raw SQL — the point is the existing operation. */
  async function deleteUserViaAdmin(userId: string): Promise<Response> {
    const token = await asAdmin("super@agentdisk.io", "admin");
    return SELF.fetch(`${URL_BASE}/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        reason: "test: account deletion cascades share links",
        confirmEmail: ADMIN_USER_EMAIL,
        revokeKeys: true,
      }),
    });
  }

  /** Also the real admin route: suspension, not a hand-written UPDATE. */
  async function suspendWorkspaceViaAdmin(workspaceId: string): Promise<Response> {
    const token = await asAdmin("admin@agentdisk.io", "admin");
    return SELF.fetch(`${URL_BASE}/v1/admin/workspaces/${workspaceId}/status`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "suspended", reason: "test: suspension cascades share links" }),
    });
  }

  it("deleting a user deletes the links they created", async () => {
    const token = await seedLiveFileShare("/mine.md");

    // Prove the link worked before the deletion, so the closing assertions
    // prove the admin action removed it rather than proving it was never
    // live in the first place.
    expect((await publicGet(`/v1/shares/open/${token}`)).status).toBe(200);

    const res = await deleteUserViaAdmin(ADMIN_USER_ID);
    expect(res.status).toBe(200);

    expect((await publicGet(`/v1/shares/open/${token}`)).status).toBe(404);
    expect(await countShareRows()).toBe(0);
  });

  it("audits the bulk deletion caused by account deletion", async () => {
    await seedLiveFileShare("/audited-delete.md");
    expect(await countShareRows()).toBe(1);

    await deleteUserViaAdmin(ADMIN_USER_ID);

    expect(await auditReasonFor(WORKSPACE_A, "share.revoked")).toBe("account deleted");
  });

  it("suspending a workspace deletes every link in it, whoever made them", async () => {
    const token = await seedLiveFileShare("/theirs.md");

    // Same discipline: prove it is live before suspending, not merely gone
    // after.
    expect((await publicGet(`/v1/shares/open/${token}`)).status).toBe(200);

    const res = await suspendWorkspaceViaAdmin(WORKSPACE_A);
    expect(res.status).toBe(200);

    expect((await publicGet(`/v1/shares/open/${token}`)).status).toBe(404);
    expect(await countShareRows()).toBe(0);
  });

  it("audits the bulk deletion caused by workspace suspension", async () => {
    await seedLiveFileShare("/audited-suspend.md");
    expect(await countShareRows()).toBe(1);

    await suspendWorkspaceViaAdmin(WORKSPACE_A);

    expect(await auditReasonFor(WORKSPACE_A, "share.revoked")).toBe("workspace suspended");
  });

  it("does not touch another workspace's links when only one is suspended", async () => {
    const tokenA = await seedLiveFileShare("/keepme.md", "fil_KEEPME");
    await env.DB.prepare(`UPDATE organizations SET plan = 'pro' WHERE id = 'org_TESTORG'`).run();
    await seedFile("fil_OTHERWS", "/other.md", WORKSPACE_B);
    await new WorkspaceScopedShares(env.DB, WORKSPACE_B).create({
      id: "shr_OTHERWS", kind: "file", fileId: "fil_OTHERWS", folderPath: null,
      token: "tokotherws", tokenHash: "hashotherws",
      expiresAt: NOW + 1000, createdBy: ADMIN_USER_ID, now: NOW,
    });
    expect(await countShareRows()).toBe(2);

    await suspendWorkspaceViaAdmin(WORKSPACE_A);

    expect((await publicGet(`/v1/shares/open/${tokenA}`)).status).toBe(404);
    expect(await findShareByToken(env.DB, "hashotherws", NOW)).not.toBeNull();
    expect(await countShareRows()).toBe(1);
  });

  it("the hourly purge removes expired rows", async () => {
    await seedFile("fil_EXP", "/exp.md");
    await new WorkspaceScopedShares(env.DB, WORKSPACE_A).create({
      id: "shr_EXP", kind: "file", fileId: "fil_EXP", folderPath: null,
      token: "expired", tokenHash: "hashexpired",
      expiresAt: NOW - 1, createdBy: ADMIN_USER_ID, now: NOW,
    });

    // Prove the row is there before the sweep, so the closing assertion
    // proves the sweep removed it rather than proving it was never inserted.
    expect(await countShareRows()).toBe(1);

    const purged = await purgeExpiredShares(env.DB, NOW);
    expect(purged).toBe(1);
    expect(await countShareRows()).toBe(0);
  });

  it("the purge leaves a live, unexpired row alone", async () => {
    const token = await seedLiveFileShare("/still-live.md", "fil_STILLLIVE");

    const purged = await purgeExpiredShares(env.DB, NOW);
    expect(purged).toBe(0);
    expect((await publicGet(`/v1/shares/open/${token}`)).status).toBe(200);
  });
});
