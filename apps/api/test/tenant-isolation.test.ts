import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { WorkspaceScopedFiles, WorkspaceScopedFolders, createWorkspaceContext } from "../src/db/workspace-scoped";
import type { FileRow } from "../src/db/types";
import { NOW, WORKSPACE_A, WORKSPACE_B, resetTenantData, seedTwoWorkspaces } from "./helpers";

/**
 * The security tests for 06 PART 16.1. These are not "does the query work"
 * tests - they assert that a repository scoped to workspace A cannot reach
 * workspace B's rows even when explicitly handed B's row IDs.
 *
 * Every assertion here corresponds to a cross-tenant scenario the design brief
 * calls out. If one of these ever fails, the tenant boundary is broken and
 * nothing else in the system matters.
 */

function fileRow(overrides: Partial<FileRow> & Pick<FileRow, "id" | "workspace_id">): FileRow {
  return {
    folder_id: null,
    name: "secret.txt",
    path: "/secret.txt",
    r2_object_key: `tenant/${overrides.workspace_id}/${overrides.id}`,
    size_bytes: 12,
    mime_type: "text/plain",
    checksum_sha256: null,
    caption: null,
    custom_metadata: null,
    status: "active",
    created_by: "usr_TESTUSER",
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
}

describe("tenant isolation", () => {
  let filesA: WorkspaceScopedFiles;
  let filesB: WorkspaceScopedFiles;

  beforeEach(async () => {
    await seedTwoWorkspaces();
    await resetTenantData();
    filesA = new WorkspaceScopedFiles(env.DB, WORKSPACE_A);
    filesB = new WorkspaceScopedFiles(env.DB, WORKSPACE_B);
  });

  it("refuses to construct without a workspace ID", () => {
    // An empty scope would fail safe by matching nothing, but it means an
    // upstream bug produced an empty scope. It must be loud, not silent.
    expect(() => new WorkspaceScopedFiles(env.DB, "")).toThrow(/without a workspace ID/);
  });

  it("cannot read another workspace's file by its exact ID", async () => {
    await filesB.insert(fileRow({ id: "fil_BSECRET", workspace_id: WORKSPACE_B }));

    // A is handed B's real, valid file ID.
    expect(await filesA.getById("fil_BSECRET")).toBeNull();
    // And B can still see its own, proving the row genuinely exists.
    expect(await filesB.getById("fil_BSECRET")).not.toBeNull();
  });

  it("cannot read another workspace's file by path", async () => {
    await filesB.insert(fileRow({ id: "fil_BPATH", workspace_id: WORKSPACE_B, path: "/shared-name.txt" }));
    await filesA.insert(fileRow({ id: "fil_APATH", workspace_id: WORKSPACE_A, path: "/shared-name.txt" }));

    // Identical paths in both workspaces must resolve to each caller's own row.
    expect((await filesA.getByPath("/shared-name.txt"))?.id).toBe("fil_APATH");
    expect((await filesB.getByPath("/shared-name.txt"))?.id).toBe("fil_BPATH");
  });

  it("never includes another workspace's rows in a listing", async () => {
    await filesA.insert(fileRow({ id: "fil_A1", workspace_id: WORKSPACE_A, path: "/docs/a.txt" }));
    await filesB.insert(fileRow({ id: "fil_B1", workspace_id: WORKSPACE_B, path: "/docs/b.txt" }));

    const listed = await filesA.listByPrefix("/docs");
    expect(listed.map((f) => f.id)).toEqual(["fil_A1"]);
  });

  it("cannot soft-delete another workspace's file", async () => {
    await filesB.insert(fileRow({ id: "fil_BDEL", workspace_id: WORKSPACE_B }));

    expect(await filesA.softDelete("fil_BDEL", NOW)).toBe(false);
    // B's file must be untouched - a write that reports failure but mutates
    // anyway would be worse than one that throws.
    expect(await filesB.getById("fil_BDEL")).not.toBeNull();
  });

  it("cannot move another workspace's file", async () => {
    await filesB.insert(fileRow({ id: "fil_BMOVE", workspace_id: WORKSPACE_B, path: "/original.txt" }));

    expect(await filesA.move("fil_BMOVE", "/stolen.txt", "stolen.txt", null, NOW)).toBe(false);
    expect((await filesB.getById("fil_BMOVE"))?.path).toBe("/original.txt");
  });

  it("cannot mark another workspace's pending file active", async () => {
    await filesB.insert(fileRow({ id: "fil_BPEND", workspace_id: WORKSPACE_B, status: "pending" }));

    expect(await filesA.markActive("fil_BPEND", 99, null, NOW)).toBe(false);
    expect((await filesB.getById("fil_BPEND"))?.status).toBe("pending");
  });

  it("refuses to insert a row belonging to another workspace", async () => {
    // Reads are scoped, but an unscoped INSERT would still be a cross-tenant
    // write. The row carries B's ID while the repository is scoped to A.
    await expect(
      filesA.insert(fileRow({ id: "fil_XWRITE", workspace_id: WORKSPACE_B }))
    ).rejects.toThrow(/another workspace/);

    expect(await filesB.getById("fil_XWRITE")).toBeNull();
  });

  it("isolates folders the same way", async () => {
    const foldersA = new WorkspaceScopedFolders(env.DB, WORKSPACE_A);
    const foldersB = new WorkspaceScopedFolders(env.DB, WORKSPACE_B);

    await foldersB.insert({
      id: "fld_BONLY",
      workspace_id: WORKSPACE_B,
      parent_folder_id: null,
      name: "private",
      path: "/private",
      created_by: "usr_TESTUSER",
      created_at: NOW,
    });

    expect(await foldersA.getById("fld_BONLY")).toBeNull();
    expect(await foldersA.getByPath("/private")).toBeNull();
    expect(await foldersA.delete("fld_BONLY")).toBe(false);
    expect(await foldersB.getById("fld_BONLY")).not.toBeNull();
  });

  it("builds every repository in the request context with the same scope", async () => {
    const context = createWorkspaceContext(env.DB, WORKSPACE_A);
    await filesB.insert(fileRow({ id: "fil_BCTX", workspace_id: WORKSPACE_B }));

    expect(await context.files.getById("fil_BCTX")).toBeNull();
    expect(await context.agents.list()).toEqual([]);
    expect(await context.apiKeys.list()).toEqual([]);
  });
});
