import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_A,
  WORKSPACE_B,
  bearer,
  resetTenantData,
  seedApiKey,
  seedTwoWorkspaces,
  setWorkspaceStatus,
} from "./helpers";
import { objectKey } from "../src/storage/keys";

const URL_BASE = "https://api-test.agentdisk.io";

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function call(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      ...bearer(token),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function makeFile(token: string, path: string, content = "bytes"): Promise<string> {
  const res = await call("POST", "/v1/files", token, { path, content: toBase64(content) });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { file: { id: string } };
  return body.file.id;
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  await resetTenantData();
  const listed = await env.FILES.list();
  for (const object of listed.objects) await env.FILES.delete(object.key);
  await setWorkspaceStatus(WORKSPACE_A, "active");
  await setWorkspaceStatus(WORKSPACE_B, "active");
  await env.DB.prepare(
    `UPDATE workspaces SET storage_bytes_used = 0, file_count = 0, egress_bytes_period = 0`
  ).run();
});

describe("POST /v1/folders", () => {
  it("creates the folder and its missing ancestors", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const res = await call("POST", "/v1/folders", token, { path: "/a/b/c" });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { folder: { path: string; name: string } };
    expect(body.folder.path).toBe("/a/b/c");
    expect(body.folder.name).toBe("c");

    const rows = await env.DB.prepare(
      `SELECT path FROM folders WHERE workspace_id = ? ORDER BY path`
    )
      .bind(WORKSPACE_A)
      .all<{ path: string }>();
    expect(rows.results?.map((row) => row.path)).toEqual(["/a", "/a/b", "/a/b/c"]);
  });

  it("links each level to its parent", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    await call("POST", "/v1/folders", token, { path: "/a/b" });

    const parent = await env.DB.prepare(`SELECT id FROM folders WHERE path = '/a' AND workspace_id = ?`)
      .bind(WORKSPACE_A)
      .first<{ id: string }>();
    const child = await env.DB.prepare(
      `SELECT parent_folder_id FROM folders WHERE path = '/a/b' AND workspace_id = ?`
    )
      .bind(WORKSPACE_A)
      .first<{ parent_folder_id: string }>();

    expect(child?.parent_folder_id).toBe(parent?.id);
  });

  it("refuses a duplicate", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    await call("POST", "/v1/folders", token, { path: "/a" });
    expect((await call("POST", "/v1/folders", token, { path: "/a" })).status).toBe(409);
  });

  it("refuses a path outside the key's scope", async () => {
    const scoped = await seedApiKey({ workspaceId: WORKSPACE_A, pathPrefix: "/agents/bot/*" });
    expect((await call("POST", "/v1/folders", scoped.token, { path: "/elsewhere" })).status).toBe(403);
  });
});

describe("DELETE /v1/folders/:id", () => {
  async function makeFolder(token: string, path: string): Promise<string> {
    const res = await call("POST", "/v1/folders", token, { path });
    const body = (await res.json()) as { folder: { id: string } };
    return body.folder.id;
  }

  it("deletes an empty folder", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const id = await makeFolder(token, "/empty");

    expect((await call("DELETE", `/v1/folders/${id}`, token)).status).toBe(200);
    const row = await env.DB.prepare(`SELECT id FROM folders WHERE id = ?`).bind(id).first();
    expect(row).toBe(null);
  });

  it("refuses a non-empty folder without ?recursive=true", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const id = await makeFolder(token, "/docs");
    await makeFile(token, "/docs/keep.txt");

    const res = await call("DELETE", `/v1/folders/${id}`, token);
    expect(res.status).toBe(409);

    // The file is untouched: a refused delete must not half-happen.
    const row = await env.DB.prepare(`SELECT status FROM files WHERE path = '/docs/keep.txt'`)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");
  });

  it("decides emptiness by path, not by folder_id", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });

    // A file created BEFORE the folder row exists has folder_id = null, but it
    // is really inside that folder. Asking the folder_id question would call
    // this folder empty and orphan the file.
    await makeFile(token, "/lazy/orphan.txt");
    const stored = await env.DB.prepare(`SELECT folder_id FROM files WHERE path = '/lazy/orphan.txt'`)
      .first<{ folder_id: string | null }>();
    expect(stored?.folder_id).toBe(null);

    const id = await makeFolder(token, "/lazy");
    expect((await call("DELETE", `/v1/folders/${id}`, token)).status).toBe(409);
  });

  it("recursively deletes and releases the usage", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const id = await makeFolder(token, "/docs");
    await makeFile(token, "/docs/one.txt", "aaaa");
    await makeFile(token, "/docs/nested/two.txt", "bb");

    const res = await call("DELETE", `/v1/folders/${id}?recursive=true`, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: number; bytes: number };
    expect(body.files).toBe(2);
    expect(body.bytes).toBe(6);

    const usage = await env.DB.prepare(
      `SELECT storage_bytes_used, file_count FROM workspaces WHERE id = ?`
    )
      .bind(WORKSPACE_A)
      .first<{ storage_bytes_used: number; file_count: number }>();
    expect(usage?.storage_bytes_used).toBe(0);
    expect(usage?.file_count).toBe(0);
  });

  it("soft-deletes on a recursive delete, so the grace window still applies", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const id = await makeFolder(token, "/docs");
    const fileId = await makeFile(token, "/docs/one.txt");

    await call("DELETE", `/v1/folders/${id}?recursive=true`, token);

    const row = await env.DB.prepare(`SELECT status, deleted_at FROM files WHERE id = ?`)
      .bind(fileId)
      .first<{ status: string; deleted_at: number | null }>();
    expect(row?.status).toBe("deleted");
    expect(row?.deleted_at).not.toBe(null);

    // Recoverable, exactly like a single delete - a recursive delete must not
    // be the one destructive path with no undo.
    expect((await call("POST", `/v1/files/${fileId}/restore`, token)).status).toBe(200);
  });

  it("cannot delete another workspace's folder", async () => {
    const a = await seedApiKey({ workspaceId: WORKSPACE_A });
    const b = await seedApiKey({ workspaceId: WORKSPACE_B });
    const id = await makeFolder(a.token, "/theirs");

    expect((await call("DELETE", `/v1/folders/${id}`, b.token)).status).toBe(404);
    expect(await env.DB.prepare(`SELECT id FROM folders WHERE id = ?`).bind(id).first()).not.toBe(null);
  });
});

describe("GET /v1/folders", () => {
  it("lists only folders within the key's scope", async () => {
    const wide = await seedApiKey({ workspaceId: WORKSPACE_A });
    await call("POST", "/v1/folders", wide.token, { path: "/agents/bot/notes" });
    await call("POST", "/v1/folders", wide.token, { path: "/elsewhere" });

    const scoped = await seedApiKey({ workspaceId: WORKSPACE_A, pathPrefix: "/agents/bot/*" });
    const res = await call("GET", "/v1/folders", scoped.token);
    const body = (await res.json()) as { folders: { path: string }[] };

    expect(body.folders.map((folder) => folder.path)).toEqual(["/agents/bot", "/agents/bot/notes"]);
  });
});

describe("POST /v1/files/:id/move", () => {
  it("moves without touching R2", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await makeFile(token, "/from/a.txt", "contents");
    const key = objectKey(WORKSPACE_A, fileId);

    const res = await call("POST", `/v1/files/${fileId}/move`, token, { path: "/to/b.txt" });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { file: { path: string; name: string } };
    expect(body.file.path).toBe("/to/b.txt");
    expect(body.file.name).toBe("b.txt");

    // Same object, same key: the key comes from the ID, and the ID did not
    // change. A move of a 5 GB file is one UPDATE.
    const stored = await env.FILES.get(key);
    expect(await stored!.text()).toBe("contents");

    const row = await env.DB.prepare(`SELECT r2_object_key FROM files WHERE id = ?`)
      .bind(fileId)
      .first<{ r2_object_key: string }>();
    expect(row?.r2_object_key).toBe(key);
  });

  it("refuses a destination outside the key's scope", async () => {
    const wide = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await makeFile(wide.token, "/agents/bot/a.txt");

    // Write access to the source must not buy write access to the destination:
    // otherwise a key scoped to /agents/bot could write anywhere by moving a
    // file it legitimately controls.
    const scoped = await seedApiKey({ workspaceId: WORKSPACE_A, pathPrefix: "/agents/bot/*" });
    const res = await call("POST", `/v1/files/${fileId}/move`, scoped.token, {
      path: "/elsewhere/a.txt",
    });
    expect(res.status).toBe(403);

    const row = await env.DB.prepare(`SELECT path FROM files WHERE id = ?`)
      .bind(fileId)
      .first<{ path: string }>();
    expect(row?.path).toBe("/agents/bot/a.txt");
  });

  it("refuses a destination that is already occupied", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await makeFile(token, "/a.txt");
    await makeFile(token, "/b.txt");

    expect((await call("POST", `/v1/files/${fileId}/move`, token, { path: "/b.txt" })).status).toBe(409);
  });
});

describe("POST /v1/files/:id/copy", () => {
  it("duplicates the bytes under a new key", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await makeFile(token, "/a.txt", "duplicate me");

    const res = await call("POST", `/v1/files/${fileId}/copy`, token, { path: "/b.txt" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { file: { id: string; sizeBytes: number } };

    expect(body.file.id).not.toBe(fileId);
    const copy = await env.FILES.get(objectKey(WORKSPACE_A, body.file.id));
    expect(await copy!.text()).toBe("duplicate me");

    // Really two objects. Sharing one would make deleting either destroy both.
    const original = await env.FILES.get(objectKey(WORKSPACE_A, fileId));
    expect(await original!.text()).toBe("duplicate me");
  });

  it("charges the copy against quota", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await makeFile(token, "/a.txt", "12345");
    await call("POST", `/v1/files/${fileId}/copy`, token, { path: "/b.txt" });

    const usage = await env.DB.prepare(
      `SELECT storage_bytes_used, file_count FROM workspaces WHERE id = ?`
    )
      .bind(WORKSPACE_A)
      .first<{ storage_bytes_used: number; file_count: number }>();
    expect(usage?.storage_bytes_used).toBe(10);
    expect(usage?.file_count).toBe(2);
  });

  it("needs read on the source and write on the destination", async () => {
    const wide = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await makeFile(wide.token, "/agents/bot/a.txt");

    const scoped = await seedApiKey({ workspaceId: WORKSPACE_A, pathPrefix: "/agents/bot/*" });
    expect(
      (await call("POST", `/v1/files/${fileId}/copy`, scoped.token, { path: "/elsewhere/a.txt" }))
        .status
    ).toBe(403);

    const readOnly = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read"] });
    expect(
      (await call("POST", `/v1/files/${fileId}/copy`, readOnly.token, { path: "/copy.txt" })).status
    ).toBe(403);
  });

  it("refuses to copy a source the key may not read, even into a path it may write", async () => {
    // The sharp case: one pathPrefix governs both ends, so a key scoped to
    // /dest may legitimately write /dest/stolen.txt. Without a read check on
    // the SOURCE, copy becomes a way to pull any file in the workspace into
    // your own scope and then read it.
    const wide = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await makeFile(wide.token, "/other/secret.txt", "classified");

    const scoped = await seedApiKey({ workspaceId: WORKSPACE_A, pathPrefix: "/dest/*" });
    const res = await call("POST", `/v1/files/${fileId}/copy`, scoped.token, {
      path: "/dest/stolen.txt",
    });
    expect(res.status).toBe(403);

    const copied = await env.DB.prepare(
      `SELECT id FROM files WHERE workspace_id = ? AND path = '/dest/stolen.txt'`
    )
      .bind(WORKSPACE_A)
      .first();
    expect(copied).toBe(null);
  });

  it("cannot copy another workspace's file", async () => {
    const a = await seedApiKey({ workspaceId: WORKSPACE_A });
    const b = await seedApiKey({ workspaceId: WORKSPACE_B });
    const fileId = await makeFile(a.token, "/theirs.txt");

    expect((await call("POST", `/v1/files/${fileId}/copy`, b.token, { path: "/mine.txt" })).status).toBe(404);
  });
});
