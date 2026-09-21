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
    expect(() => resolveExpiry(NOW + MAX_SHARE_TTL_MS + 1000, NOW)).toThrow(/7 days/);
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
