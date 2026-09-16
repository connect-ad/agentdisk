/**
 * GET /v1/search — 05 PART 10.5 level 1.
 *
 * The case that matters is scope. A search that applies the caller's path
 * prefix *after* matching leaks the existence of files outside it — not through
 * the rows, which get dropped, but through the count, the pagination and the
 * timing. So the prefix belongs inside the same statement as the match, and
 * these tests check the observable consequence of that.
 *
 * The other half is the LIKE metacharacters. A query of `%` that returns
 * everything is a search box that quietly enumerates the workspace.
 */

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { NOW, WORKSPACE_A, WORKSPACE_B, bearer, seedApiKey, seedTwoWorkspaces } from "./helpers";

const URL_BASE = "https://api-dev.agentdisk.io";

async function seedFile(options: {
  id: string;
  path: string;
  workspaceId?: string;
  caption?: string | null;
  tag?: string;
}): Promise<void> {
  const { id, path, workspaceId = WORKSPACE_A, caption = null, tag } = options;
  const name = path.split("/").pop() ?? path;
  await env.DB.prepare(
    `INSERT INTO files
       (id, workspace_id, folder_id, path, name, size_bytes, mime_type, checksum_sha256,
        r2_object_key, status, caption, created_by, created_at, updated_at, deleted_at)
     VALUES (?, ?, NULL, ?, ?, 10, 'text/plain', NULL, ?, 'active', ?, 'usr_TESTUSER', ?, ?, NULL)`
  )
    .bind(id, workspaceId, path, name, `tenant/${workspaceId}/${id}`, caption, NOW, NOW)
    .run();

  if (tag !== undefined) {
    await env.DB.prepare(`INSERT INTO file_tags (file_id, tag) VALUES (?, ?)`).bind(id, tag).run();
  }
}

async function search(token: string, query: string): Promise<Response> {
  return SELF.fetch(`${URL_BASE}/v1/search?${query}`, { headers: bearer(token) });
}

async function paths(res: Response): Promise<string[]> {
  const body = (await res.json()) as { files: { path: string }[] };
  return body.files.map(f => f.path).sort();
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  await env.DB.prepare(`DELETE FROM file_tags`).run();
  await env.DB.prepare(`DELETE FROM files`).run();
  await env.DB.prepare(`DELETE FROM api_keys`).run();
});

describe("matching", () => {
  it("finds by name and by path", async () => {
    await seedFile({ id: "fil_1", path: "/reports/q1-summary.pdf" });
    await seedFile({ id: "fil_2", path: "/notes/reading-list.md" });
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list", "read"] });

    expect(await paths(await search(token, "q=summary"))).toEqual(["/reports/q1-summary.pdf"]);
    expect(await paths(await search(token, "q=notes"))).toEqual(["/notes/reading-list.md"]);
  });

  it("finds by caption and by tag", async () => {
    await seedFile({ id: "fil_3", path: "/a.txt", caption: "quarterly revenue breakdown" });
    await seedFile({ id: "fil_4", path: "/b.txt", tag: "confidential" });
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list", "read"] });

    expect(await paths(await search(token, "q=revenue"))).toEqual(["/a.txt"]);
    expect(await paths(await search(token, "q=confidential"))).toEqual(["/b.txt"]);
  });

  it("says which fields it looked at", async () => {
    // So an empty result is not read as "that file does not exist" when the
    // query was really about contents, which are not indexed.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list"] });
    const body = (await (await search(token, "q=anything")).json()) as { searchedFields: string[] };
    expect(body.searchedFields).toEqual(["name", "path", "caption", "tags"]);
  });

  it("does not return deleted files", async () => {
    await seedFile({ id: "fil_5", path: "/gone.txt" });
    await env.DB.prepare(`UPDATE files SET deleted_at = ?, status = 'deleted' WHERE id = ?`)
      .bind(NOW, "fil_5").run();
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list"] });

    expect(await paths(await search(token, "q=gone"))).toEqual([]);
  });

  it("requires a query", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list"] });
    expect((await search(token, "q=")).status).toBe(400);
    expect((await search(token, "")).status).toBe(400);
  });
});

describe("scope", () => {
  it("cannot see outside the key's path prefix", async () => {
    await seedFile({ id: "fil_in", path: "/agents/bot/secret-plan.txt" });
    await seedFile({ id: "fil_out", path: "/humans/secret-plan.txt" });
    const { token } = await seedApiKey({
      workspaceId: WORKSPACE_A,
      ops: ["list", "read"],
      pathPrefix: "/agents/bot",
    });

    // Both match the term. Only one is reachable, and the other must not even
    // register in the count.
    const body = (await (await search(token, "q=secret-plan")).json()) as {
      files: { path: string }[];
    };
    expect(body.files).toHaveLength(1);
    expect(body.files[0]?.path).toBe("/agents/bot/secret-plan.txt");
  });

  it("cannot see another workspace's files", async () => {
    await seedFile({ id: "fil_mine", path: "/shared-name.txt", workspaceId: WORKSPACE_A });
    await seedFile({ id: "fil_theirs", path: "/shared-name.txt", workspaceId: WORKSPACE_B });
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list", "read"] });

    const body = (await (await search(token, "q=shared-name")).json()) as { files: unknown[] };
    expect(body.files).toHaveLength(1);
  });

  it("needs list, not merely read", async () => {
    // Searching is enumeration. A key that may read a file it already knows
    // about must not be able to discover others one query at a time.
    await seedFile({ id: "fil_6", path: "/findable.txt" });
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read"] });
    expect((await search(token, "q=findable")).status).toBe(403);
  });
});

describe("LIKE metacharacters", () => {
  it("treats % as a literal, not a wildcard", async () => {
    // Otherwise the search box is an enumeration tool.
    await seedFile({ id: "fil_7", path: "/ordinary.txt" });
    await seedFile({ id: "fil_8", path: "/100%-done.txt" });
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list", "read"] });

    const results = await paths(await search(token, `q=${encodeURIComponent("%")}`));
    expect(results).toEqual(["/100%-done.txt"]);
  });

  it("treats _ as a literal too", async () => {
    await seedFile({ id: "fil_9", path: "/ab.txt" });
    await seedFile({ id: "fil_10", path: "/a_b.txt" });
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list", "read"] });

    const results = await paths(await search(token, `q=${encodeURIComponent("a_b")}`));
    expect(results).toEqual(["/a_b.txt"]);
  });
});

describe("pagination", () => {
  it("pages with a cursor", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedFile({ id: `fil_p${i}`, path: `/page/item-${i}.txt` });
    }
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list", "read"] });

    const first = (await (await search(token, "q=item&limit=2")).json()) as {
      files: { id: string }[];
      nextCursor: string | null;
    };
    expect(first.files).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = (await (
      await search(token, `q=item&limit=2&cursor=${first.nextCursor}`)
    ).json()) as { files: { id: string }[] };
    // No overlap - a cursor that repeated a row would make a client loop.
    const firstIds = first.files.map(f => f.id);
    expect(second.files.every(f => !firstIds.includes(f.id))).toBe(true);
  });

  it("rejects an out-of-range limit", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["list"] });
    expect((await search(token, "q=x&limit=0")).status).toBe(400);
    expect((await search(token, "q=x&limit=99999")).status).toBe(400);
  });
});
