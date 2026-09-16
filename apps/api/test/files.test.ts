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
import { WorkspaceScopedFiles } from "../src/db/workspace-scoped";

const URL_BASE = "https://api-test.agentdisk.io";

interface ErrorBody {
  error: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

/** Clear R2 between tests; D1 is cleared by resetTenantData. */
async function resetBucket(): Promise<void> {
  const listed = await env.FILES.list();
  for (const object of listed.objects) {
    await env.FILES.delete(object.key);
  }
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  await resetTenantData();
  await resetBucket();
  await setWorkspaceStatus(WORKSPACE_A, "active");
  await setWorkspaceStatus(WORKSPACE_B, "active");
  await env.DB.prepare(
    `UPDATE workspaces SET storage_bytes_used = 0, file_count = 0, egress_bytes_period = 0`
  ).run();
});

describe("POST /v1/files - inline upload", () => {
  it("stores the bytes and returns an active file", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const content = "# notes\nhello";

    const res = await call("POST", "/v1/files", token, {
      path: "/notes/a.md",
      mimeType: "text/markdown",
      content: toBase64(content),
      caption: "a caption",
      tags: ["research", "weekly"],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { file: Record<string, unknown> };
    expect(body.file.status).toBe("active");
    expect(body.file.path).toBe("/notes/a.md");
    expect(body.file.name).toBe("a.md");
    expect(body.file.sizeBytes).toBe(content.length);
    expect(body.file.tags).toEqual(["research", "weekly"]);

    // The bytes are really in R2, under the server-generated key.
    const stored = await env.FILES.get(objectKey(WORKSPACE_A, body.file.id as string));
    expect(stored).not.toBe(null);
    expect(await stored!.text()).toBe(content);
  });

  it("books the bytes against the workspace's usage", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    await call("POST", "/v1/files", token, { path: "/a.txt", content: toBase64("12345") });

    const row = await env.DB.prepare(
      `SELECT storage_bytes_used, file_count FROM workspaces WHERE id = ?`
    )
      .bind(WORKSPACE_A)
      .first<{ storage_bytes_used: number; file_count: number }>();

    expect(row?.storage_bytes_used).toBe(5);
    expect(row?.file_count).toBe(1);
  });

  it("never lets the client's path reach the object key", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });

    // A traversal attempt is rejected outright by path validation...
    const traversal = await call("POST", "/v1/files", token, {
      path: "/notes/../../etc/passwd",
      content: toBase64("x"),
    });
    expect(traversal.status).toBe(400);

    // ...and even a legal, strange-looking path produces a key built only from
    // IDs, so nothing a client writes can steer where the bytes land.
    const res = await call("POST", "/v1/files", token, {
      path: "/notes/tenant/ws_OTHER/evil.txt",
      content: toBase64("x"),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { file: { id: string } };

    const stored = await env.DB.prepare(`SELECT r2_object_key FROM files WHERE id = ?`)
      .bind(body.file.id)
      .first<{ r2_object_key: string }>();
    expect(stored?.r2_object_key).toBe(`tenant/${WORKSPACE_A}/${body.file.id}`);
  });

  it("refuses a second file at the same path", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    await call("POST", "/v1/files", token, { path: "/a.txt", content: toBase64("one") });
    const res = await call("POST", "/v1/files", token, { path: "/a.txt", content: toBase64("two") });

    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("CONFLICT");
  });

  it("refuses content that is not base64 rather than storing different bytes", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const res = await call("POST", "/v1/files", token, { path: "/a.txt", content: "not base64!!" });
    expect(res.status).toBe(400);
  });

  it("lets R2 reject a body that does not match its declared checksum", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const wrongChecksum = await sha256Hex("something else entirely");

    const res = await call("POST", "/v1/files", token, {
      path: "/a.txt",
      content: toBase64("the actual bytes"),
      checksumSha256: wrongChecksum,
    });

    // The point is that it does not become an active file with a checksum that
    // lies about its contents.
    expect(res.status).not.toBe(201);
    const rows = await env.DB.prepare(
      `SELECT status FROM files WHERE workspace_id = ? AND path = '/a.txt'`
    )
      .bind(WORKSPACE_A)
      .all<{ status: string }>();
    expect(rows.results?.every((row) => row.status !== "active")).toBe(true);
  });

  it("accepts a body that does match its declared checksum", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const content = "the actual bytes";
    const res = await call("POST", "/v1/files", token, {
      path: "/a.txt",
      content: toBase64(content),
      checksumSha256: await sha256Hex(content),
    });
    expect(res.status).toBe(201);
  });

  it("refuses inline content above the 1 MB cap", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const oversize = toBase64("x".repeat(1024 * 1024 + 1));
    const res = await call("POST", "/v1/files", token, { path: "/big.bin", content: oversize });
    expect(res.status).toBe(413);
  });
});

describe("POST /v1/files - presigned upload", () => {
  it("returns a URL scoped to exactly this file's key, and a pending row", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const res = await call("POST", "/v1/files", token, {
      path: "/big/video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 5_000_000,
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      file: { id: string; status: string; sizeBytes: number };
      upload: { url: string; method: string; expiresAt: string };
    };

    expect(body.file.status).toBe("pending");
    // Not 5,000,000: nothing has been uploaded, and believing the declared size
    // here would let a client inflate its usage without sending a byte.
    expect(body.file.sizeBytes).toBe(0);

    expect(body.upload.method).toBe("PUT");
    const url = new URL(body.upload.url);
    expect(url.pathname).toContain(objectKey(WORKSPACE_A, body.file.id));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  it("does not count the file until it is completed", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    await call("POST", "/v1/files", token, { path: "/big/v.mp4", sizeBytes: 1000 });

    const row = await env.DB.prepare(
      `SELECT storage_bytes_used, file_count FROM workspaces WHERE id = ?`
    )
      .bind(WORKSPACE_A)
      .first<{ storage_bytes_used: number; file_count: number }>();
    expect(row?.storage_bytes_used).toBe(0);
    expect(row?.file_count).toBe(0);
  });
});

describe("POST /v1/files/:id/complete", () => {
  async function startUpload(token: string, path = "/big/v.bin", sizeBytes = 100) {
    const res = await call("POST", "/v1/files", token, { path, sizeBytes });
    const body = (await res.json()) as { file: { id: string } };
    return body.file.id;
  }

  it("books the size R2 actually holds, not the size the client claimed", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await startUpload(token);

    // Simulate the direct PUT: 12 bytes, not the 100 that were declared.
    await env.FILES.put(objectKey(WORKSPACE_A, fileId), "twelve bytes");

    const res = await call("POST", `/v1/files/${fileId}/complete`, token, { sizeBytes: 100 });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { file: { sizeBytes: number; status: string }; notice?: string };
    expect(body.file.status).toBe("active");
    expect(body.file.sizeBytes).toBe(12);
    expect(body.notice).toContain("stored 12");

    const row = await env.DB.prepare(`SELECT storage_bytes_used FROM workspaces WHERE id = ?`)
      .bind(WORKSPACE_A)
      .first<{ storage_bytes_used: number }>();
    expect(row?.storage_bytes_used).toBe(12);

    // The row itself, not only the response body and the counter. Everything
    // downstream - listings, and the egress charged for a download - reads the
    // size from here, so a stored size that believed the client would quietly
    // mis-report and mis-bill this file forever after.
    const stored = await env.DB.prepare(`SELECT size_bytes FROM files WHERE id = ?`)
      .bind(fileId)
      .first<{ size_bytes: number }>();
    expect(stored?.size_bytes).toBe(12);
  });

  it("refuses to complete a file whose bytes were never uploaded", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await startUpload(token);

    const res = await call("POST", `/v1/files/${fileId}/complete`, token, {});
    expect(res.status).toBe(409);
  });

  it("discards an upload that exceeds the plan's per-file cap", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await startUpload(token, "/big/huge.bin", 10);

    // Free plan caps a single file at 100 MB. Claim 10 bytes, upload more.
    const oversize = new Uint8Array(100 * 1024 * 1024 + 1);
    await env.FILES.put(objectKey(WORKSPACE_A, fileId), oversize);

    const res = await call("POST", `/v1/files/${fileId}/complete`, token, { sizeBytes: 10 });
    expect(res.status).toBe(413);

    // The bytes are gone, not orphaned in the bucket consuming storage that
    // nothing is accounting for.
    expect(await env.FILES.head(objectKey(WORKSPACE_A, fileId))).toBe(null);

    const row = await env.DB.prepare(`SELECT status FROM files WHERE id = ?`)
      .bind(fileId)
      .first<{ status: string }>();
    expect(row?.status).toBe("failed");
  });

  it("cannot be completed twice", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await startUpload(token);
    await env.FILES.put(objectKey(WORKSPACE_A, fileId), "bytes");

    expect((await call("POST", `/v1/files/${fileId}/complete`, token, {})).status).toBe(200);
    expect((await call("POST", `/v1/files/${fileId}/complete`, token, {})).status).toBe(409);

    const row = await env.DB.prepare(`SELECT storage_bytes_used FROM workspaces WHERE id = ?`)
      .bind(WORKSPACE_A)
      .first<{ storage_bytes_used: number }>();
    expect(row?.storage_bytes_used).toBe(5);
  });
});

describe("GET /v1/files", () => {
  async function seedFiles(token: string, paths: string[]): Promise<void> {
    for (const path of paths) {
      const res = await call("POST", "/v1/files", token, { path, content: toBase64("x") });
      expect(res.status).toBe(201);
    }
  }

  it("lists only this workspace's files", async () => {
    const a = await seedApiKey({ workspaceId: WORKSPACE_A });
    const b = await seedApiKey({ workspaceId: WORKSPACE_B });
    await seedFiles(a.token, ["/one.txt", "/two.txt"]);
    await seedFiles(b.token, ["/other.txt"]);

    const res = await call("GET", "/v1/files", a.token);
    const body = (await res.json()) as { files: { path: string }[] };
    expect(body.files.map((file) => file.path).sort()).toEqual(["/one.txt", "/two.txt"]);
  });

  it("narrows a too-broad request to the key's own prefix rather than refusing", async () => {
    const wide = await seedApiKey({ workspaceId: WORKSPACE_A });
    await seedFiles(wide.token, ["/agents/bot/in-scope.txt", "/elsewhere/out-of-scope.txt"]);

    const scoped = await seedApiKey({ workspaceId: WORKSPACE_A, pathPrefix: "/agents/bot/*" });
    const res = await call("GET", "/v1/files", scoped.token);
    const body = (await res.json()) as { files: { path: string }[] };
    expect(body.files.map((file) => file.path)).toEqual(["/agents/bot/in-scope.txt"]);
  });

  it("narrows an explicitly broader path request instead of refusing it", async () => {
    // Asking to list "/agents" with a key scoped to "/agents/bot" is a normal
    // request - the caller wants everything they can see under there. It gets
    // narrowed to the scope, not rejected, and the narrowing happens in SQL so
    // an out-of-scope row is never fetched and filtered afterwards.
    const wide = await seedApiKey({ workspaceId: WORKSPACE_A });
    await seedFiles(wide.token, ["/agents/bot/mine.txt", "/agents/other/theirs.txt"]);

    const scoped = await seedApiKey({ workspaceId: WORKSPACE_A, pathPrefix: "/agents/bot/*" });
    const res = await call("GET", "/v1/files?path=/agents", scoped.token);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { files: { path: string }[] };
    expect(body.files.map((file) => file.path)).toEqual(["/agents/bot/mine.txt"]);
  });

  it("refuses a request for a path disjoint from the key's scope", async () => {
    const scoped = await seedApiKey({ workspaceId: WORKSPACE_A, pathPrefix: "/agents/bot/*" });
    const res = await call("GET", "/v1/files?path=/other", scoped.token);
    expect(res.status).toBe(403);
  });

  it("does not let a '%' in a path widen the listing", async () => {
    // LIKE treats '%' as a wildcard, so an unescaped prefix would make a
    // listing for '/a%' also return '/anything-else'. Not a tenant hole, but an
    // information leak inside the workspace.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    await seedFiles(token, ["/a%/inside.txt", "/ab/outside.txt"]);

    const res = await call("GET", `/v1/files?path=${encodeURIComponent("/a%")}`, token);
    const body = (await res.json()) as { files: { path: string }[] };
    expect(body.files.map((file) => file.path)).toEqual(["/a%/inside.txt"]);
  });

  it("paginates with a cursor that does not repeat or skip", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    await seedFiles(token, ["/1.txt", "/2.txt", "/3.txt", "/4.txt", "/5.txt"]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const query: string = cursor === null ? "?limit=2" : `?limit=2&cursor=${cursor}`;
      const res: Response = await call("GET", `/v1/files${query}`, token);
      const body = (await res.json()) as { files: { path: string }[]; nextCursor: string | null };
      seen.push(...body.files.map((file) => file.path));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }

    expect(seen.sort()).toEqual(["/1.txt", "/2.txt", "/3.txt", "/4.txt", "/5.txt"]);
    expect(new Set(seen).size).toBe(5);
  });

  it("rejects an out-of-range limit", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    expect((await call("GET", "/v1/files?limit=201", token)).status).toBe(400);
    expect((await call("GET", "/v1/files?limit=0", token)).status).toBe(400);
  });
});

describe("GET /v1/files/:id", () => {
  it("returns another workspace's file as 404, not 403", async () => {
    const a = await seedApiKey({ workspaceId: WORKSPACE_A });
    const b = await seedApiKey({ workspaceId: WORKSPACE_B });

    const created = await call("POST", "/v1/files", a.token, {
      path: "/secret.txt",
      content: toBase64("secret"),
    });
    const { file } = (await created.json()) as { file: { id: string } };

    // 404 rather than 403: a 403 would confirm the ID names a real file
    // somewhere, which is an existence oracle across tenants.
    const res = await call("GET", `/v1/files/${file.id}`, b.token);
    expect(res.status).toBe(404);
  });

  it("refuses a file outside the key's path scope", async () => {
    const wide = await seedApiKey({ workspaceId: WORKSPACE_A });
    const created = await call("POST", "/v1/files", wide.token, {
      path: "/elsewhere/x.txt",
      content: toBase64("x"),
    });
    const { file } = (await created.json()) as { file: { id: string } };

    const scoped = await seedApiKey({ workspaceId: WORKSPACE_A, pathPrefix: "/agents/bot/*" });
    const res = await call("GET", `/v1/files/${file.id}`, scoped.token);
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/files/:id/download", () => {
  async function activeFile(token: string, content = "downloadable"): Promise<string> {
    const res = await call("POST", "/v1/files", token, {
      path: "/d.txt",
      content: toBase64(content),
    });
    const { file } = (await res.json()) as { file: { id: string } };
    return file.id;
  }

  it("returns a GET URL scoped to that one object", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await activeFile(token);

    const res = await call("GET", `/v1/files/${fileId}/download`, token);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { url: string; sizeBytes: number };
    const url = new URL(body.url);
    expect(url.pathname).toContain(objectKey(WORKSPACE_A, fileId));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(body.sizeBytes).toBe("downloadable".length);
  });

  it("accounts egress when the URL is issued", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await activeFile(token);
    await call("GET", `/v1/files/${fileId}/download`, token);

    const row = await env.DB.prepare(`SELECT egress_bytes_period FROM workspaces WHERE id = ?`)
      .bind(WORKSPACE_A)
      .first<{ egress_bytes_period: number }>();
    expect(row?.egress_bytes_period).toBe("downloadable".length);
  });

  it("refuses to sign a download for a file with no bytes", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const started = await call("POST", "/v1/files", token, { path: "/p.bin", sizeBytes: 10 });
    const { file } = (await started.json()) as { file: { id: string } };

    const res = await call("GET", `/v1/files/${file.id}/download`, token);
    expect(res.status).toBe(409);
  });

  it("needs read scope", async () => {
    const writer = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["write"] });
    const created = await call("POST", "/v1/files", writer.token, {
      path: "/d.txt",
      content: toBase64("x"),
    });
    const { file } = (await created.json()) as { file: { id: string } };

    const res = await call("GET", `/v1/files/${file.id}/download`, writer.token);
    expect(res.status).toBe(403);
  });
});

describe("DELETE and restore", () => {
  async function activeFile(token: string, content = "bytes"): Promise<string> {
    const res = await call("POST", "/v1/files", token, {
      path: "/gone.txt",
      content: toBase64(content),
    });
    const { file } = (await res.json()) as { file: { id: string } };
    return file.id;
  }

  it("soft-deletes and releases the usage", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await activeFile(token);

    const res = await call("DELETE", `/v1/files/${fileId}`, token);
    expect(res.status).toBe(200);

    // The row survives (10.7) and the bytes are still there until the purge.
    const row = await env.DB.prepare(`SELECT status, deleted_at FROM files WHERE id = ?`)
      .bind(fileId)
      .first<{ status: string; deleted_at: number | null }>();
    expect(row?.status).toBe("deleted");
    expect(row?.deleted_at).not.toBe(null);
    expect(await env.FILES.head(objectKey(WORKSPACE_A, fileId))).not.toBe(null);

    const usage = await env.DB.prepare(
      `SELECT storage_bytes_used, file_count FROM workspaces WHERE id = ?`
    )
      .bind(WORKSPACE_A)
      .first<{ storage_bytes_used: number; file_count: number }>();
    expect(usage?.storage_bytes_used).toBe(0);
    expect(usage?.file_count).toBe(0);
  });

  it("hides a deleted file from get and list", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await activeFile(token);
    await call("DELETE", `/v1/files/${fileId}`, token);

    expect((await call("GET", `/v1/files/${fileId}`, token)).status).toBe(404);
    const listed = (await (await call("GET", "/v1/files", token)).json()) as { files: unknown[] };
    expect(listed.files).toEqual([]);
  });

  it("restores within the grace window and re-books the usage", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await activeFile(token);
    await call("DELETE", `/v1/files/${fileId}`, token);

    const res = await call("POST", `/v1/files/${fileId}/restore`, token);
    expect(res.status).toBe(200);

    const usage = await env.DB.prepare(
      `SELECT storage_bytes_used, file_count FROM workspaces WHERE id = ?`
    )
      .bind(WORKSPACE_A)
      .first<{ storage_bytes_used: number; file_count: number }>();
    expect(usage?.storage_bytes_used).toBe("bytes".length);
    expect(usage?.file_count).toBe(1);

    expect((await call("GET", `/v1/files/${fileId}`, token)).status).toBe(200);
  });

  it("will not restore a file deleted longer ago than the grace window", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await activeFile(token);
    await call("DELETE", `/v1/files/${fileId}`, token);

    // Backdate the deletion past the 24h window. Rewriting the row is the only
    // way to test this from outside: the handler reads the clock, so the test
    // has to move the file rather than the time.
    await env.DB.prepare(`UPDATE files SET deleted_at = ? WHERE id = ?`)
      .bind(Date.now() - (25 * 60 * 60 * 1000), fileId)
      .run();

    const res = await call("POST", `/v1/files/${fileId}/restore`, token);
    expect(res.status).toBe(409);

    const row = await env.DB.prepare(`SELECT status FROM files WHERE id = ?`)
      .bind(fileId)
      .first<{ status: string }>();
    expect(row?.status).toBe("deleted");
  });

  it("will not restore a file whose bytes are already purged", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await activeFile(token);
    await call("DELETE", `/v1/files/${fileId}`, token);
    await env.FILES.delete(objectKey(WORKSPACE_A, fileId));

    const res = await call("POST", `/v1/files/${fileId}/restore`, token);
    expect(res.status).toBe(409);
  });

  it("needs delete scope, not write", async () => {
    const wide = await seedApiKey({ workspaceId: WORKSPACE_A });
    const fileId = await activeFile(wide.token);

    const writer = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "write"] });
    expect((await call("DELETE", `/v1/files/${fileId}`, writer.token)).status).toBe(403);
  });

  it("cannot delete another workspace's file", async () => {
    const a = await seedApiKey({ workspaceId: WORKSPACE_A });
    const b = await seedApiKey({ workspaceId: WORKSPACE_B });
    const fileId = await activeFile(a.token);

    expect((await call("DELETE", `/v1/files/${fileId}`, b.token)).status).toBe(404);

    const row = await env.DB.prepare(`SELECT status FROM files WHERE id = ?`)
      .bind(fileId)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");
  });
});

describe("PATCH /v1/files/:id", () => {
  it("updates metadata and tags without touching the bytes", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const created = await call("POST", "/v1/files", token, {
      path: "/m.txt",
      content: toBase64("body"),
      tags: ["old"],
    });
    const { file } = (await created.json()) as { file: { id: string } };

    const res = await call("PATCH", `/v1/files/${file.id}`, token, {
      caption: "new caption",
      tags: ["new", "tags"],
      metadata: { source: "test" },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      file: { caption: string; tags: string[]; metadata: Record<string, string>; sizeBytes: number };
    };
    expect(body.file.caption).toBe("new caption");
    expect(body.file.tags).toEqual(["new", "tags"]);
    expect(body.file.metadata).toEqual({ source: "test" });
    expect(body.file.sizeBytes).toBe(4);

    const stored = await env.FILES.get(objectKey(WORKSPACE_A, file.id));
    expect(await stored!.text()).toBe("body");
  });
});

describe("routing", () => {
  it("does not treat a lookalike path as a file route", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    // Segment matching, not startsWith: "/v1/filesX" is a different route.
    expect((await call("GET", "/v1/filesX", token)).status).toBe(404);
  });

  it("rejects an unknown method on a known route", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    expect((await call("PUT", "/v1/files", token)).status).toBe(404);
  });
});

describe("file_tags is scoped through its file", () => {
  it("refuses to tag a file belonging to another workspace", async () => {
    // Unreachable through HTTP - every route fetches the file through a scoped
    // repository first, so a cross-tenant file ID is a 404 long before tagging.
    // This drives the repository directly, because the SQL guard is defence in
    // depth and defence in depth that is never exercised is just a comment.
    const a = await seedApiKey({ workspaceId: WORKSPACE_A });
    const created = await call("POST", "/v1/files", a.token, {
      path: "/theirs.txt",
      content: toBase64("x"),
      tags: ["original"],
    });
    const { file } = (await created.json()) as { file: { id: string } };

    const attacker = new WorkspaceScopedFiles(env.DB, WORKSPACE_B);
    await attacker.setTags(file.id, ["injected"]);

    // file_tags has no workspace_id of its own, so the write re-proves
    // ownership in SQL. It affects zero rows rather than retagging the file.
    const owner = new WorkspaceScopedFiles(env.DB, WORKSPACE_A);
    expect(await owner.getTags(file.id)).toEqual(["original"]);
  });

  it("returns no tags when read through the wrong workspace", async () => {
    const a = await seedApiKey({ workspaceId: WORKSPACE_A });
    const created = await call("POST", "/v1/files", a.token, {
      path: "/theirs.txt",
      content: toBase64("x"),
      tags: ["secret-label"],
    });
    const { file } = (await created.json()) as { file: { id: string } };

    const attacker = new WorkspaceScopedFiles(env.DB, WORKSPACE_B);
    expect(await attacker.getTags(file.id)).toEqual([]);
  });
});
