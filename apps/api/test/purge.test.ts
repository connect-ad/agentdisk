/**
 * Reaping and reconciliation — 05 PART 12.5, 10.8.
 *
 * These close a real gap rather than guard a hypothetical one. A delete is
 * three steps across two systems with no transaction between them, so a
 * request can die holding a row marked `deleted` whose bytes are still in R2 —
 * invisible to every read, paid for, charged to nobody. And the usage counters
 * are maintained incrementally, which means they drift, and a customer billed
 * against a drifted counter is either overcharged or storing for free.
 *
 * What the reaper must NOT do is take a row whose own request is still running.
 * That is what REAP_AFTER_MS is for, and it is the one timing here worth being
 * careful about — nothing is recoverable, so a row taken early is a request
 * that fails after the file is already gone.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { reapStrandedFiles, reconcileCounters, REAP_AFTER_MS } from "../src/jobs/purge";
import { NOW, ORG_ID, WORKSPACE_A, WORKSPACE_B, seedTwoWorkspaces } from "./helpers";
import { createWorkspaceContext } from "../src/db/workspace-scoped";

async function seedFile(options: {
  id: string;
  workspaceId?: string;
  status?: string;
  deletedAt?: number | null;
  sizeBytes?: number;
  objectKey?: string | null;
}): Promise<void> {
  const {
    id,
    workspaceId = WORKSPACE_A,
    status = "active",
    deletedAt = null,
    sizeBytes = 100,
    objectKey = `tenant/${workspaceId}/${id}`,
  } = options;

  await env.DB.prepare(
    `INSERT INTO files
       (id, workspace_id, folder_id, path, name, size_bytes, mime_type, checksum_sha256,
        r2_object_key, status, created_by, created_at, updated_at, deleted_at)
     VALUES (?, ?, NULL, ?, ?, ?, 'text/plain', NULL, ?, ?, 'usr_TESTUSER', ?, ?, ?)`
  )
    .bind(id, workspaceId, `/${id}.txt`, `${id}.txt`, sizeBytes, objectKey, status, NOW, NOW, deletedAt)
    .run();

  if (objectKey !== null) {
    await env.FILES.put(objectKey, new Uint8Array(sizeBytes));
  }
}

async function fileExists(id: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS ok FROM files WHERE id = ?`).bind(id).first();
  return row !== null;
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  await env.DB.prepare(`DELETE FROM file_tags`).run();
  await env.DB.prepare(`DELETE FROM files`).run();
  await env.DB.prepare(
    `UPDATE workspaces SET storage_bytes_used = 0, file_count = 0`
  ).run();
  await env.DB.prepare(
    `UPDATE organizations SET storage_bytes_used = 0, file_count = 0`
  ).run();
});

describe("reaping stranded files", () => {
  it("removes a row left marked, and its object", async () => {
    await seedFile({ id: "fil_OLD", status: "deleted", deletedAt: NOW - REAP_AFTER_MS - 1000 });

    const result = await reapStrandedFiles(env.DB, env.FILES, NOW);
    expect(result).toMatchObject({ examined: 1, rowsDeleted: 1, failed: 0 });
    expect(await fileExists("fil_OLD")).toBe(false);
    expect(await env.FILES.head(`tenant/${WORKSPACE_A}/fil_OLD`)).toBeNull();
  });

  it("leaves a row whose own delete may still be running", async () => {
    // `deleteFile` marks, then awaits R2. Reaping inside that gap races the
    // request for no gain, so the margin is respected rather than raced.
    await seedFile({ id: "fil_RECENT", status: "deleted", deletedAt: NOW - 1_000 });

    const result = await reapStrandedFiles(env.DB, env.FILES, NOW);
    expect(result.examined).toBe(0);
    expect(await fileExists("fil_RECENT")).toBe(true);
    expect(await env.FILES.head(`tenant/${WORKSPACE_A}/fil_RECENT`)).not.toBeNull();
  });

  it("does not touch active files", async () => {
    await seedFile({ id: "fil_LIVE", status: "active" });
    await reapStrandedFiles(env.DB, env.FILES, NOW);
    expect(await fileExists("fil_LIVE")).toBe(true);
  });

  it("reaps across workspaces in one sweep", async () => {
    // It is a platform job, not a tenant-scoped one - which is exactly why it
    // lives outside the workspace-scoped repositories.
    await seedFile({ id: "fil_A", workspaceId: WORKSPACE_A, status: "deleted", deletedAt: NOW - REAP_AFTER_MS - 1 });
    await seedFile({ id: "fil_B", workspaceId: WORKSPACE_B, status: "deleted", deletedAt: NOW - REAP_AFTER_MS - 1 });

    const result = await reapStrandedFiles(env.DB, env.FILES, NOW);
    expect(result.rowsDeleted).toBe(2);
  });

  it("treats an already-missing object as success", async () => {
    // A retry after a partial run must converge, not fail forever. The desired
    // state is "no object", and it already holds.
    await seedFile({ id: "fil_GONE", status: "deleted", deletedAt: NOW - REAP_AFTER_MS - 1 });
    await env.FILES.delete(`tenant/${WORKSPACE_A}/fil_GONE`);

    const result = await reapStrandedFiles(env.DB, env.FILES, NOW);
    expect(result.failed).toBe(0);
    expect(await fileExists("fil_GONE")).toBe(false);
  });

  it("is bounded, so one run cannot exceed its budget", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedFile({ id: `fil_M${i}`, status: "deleted", deletedAt: NOW - REAP_AFTER_MS - 1 });
    }
    const result = await reapStrandedFiles(env.DB, env.FILES, NOW, 2);
    expect(result.examined).toBe(2);
    expect(result.rowsDeleted).toBe(2);

    // The rest stay for the next run rather than being lost.
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM files`).first<{ n: number }>();
    expect(left?.n).toBe(3);
  });

  it("takes the oldest first, so a backlog drains in order", async () => {
    await seedFile({ id: "fil_NEWER", status: "deleted", deletedAt: NOW - REAP_AFTER_MS - 1000 });
    await seedFile({ id: "fil_OLDER", status: "deleted", deletedAt: NOW - REAP_AFTER_MS - 99_000 });

    await reapStrandedFiles(env.DB, env.FILES, NOW, 1);
    expect(await fileExists("fil_OLDER")).toBe(false);
    expect(await fileExists("fil_NEWER")).toBe(true);
  });
});

describe("reconciliation", () => {
  it("corrects a drifted counter", async () => {
    await seedFile({ id: "fil_1", sizeBytes: 500 });
    await seedFile({ id: "fil_2", sizeBytes: 300 });
    await env.DB.prepare(
      `UPDATE workspaces SET storage_bytes_used = 99999, file_count = 42 WHERE id = ?`
    ).bind(WORKSPACE_A).run();

    const result = await reconcileCounters(env.DB, NOW);
    expect(result.workspacesCorrected).toBeGreaterThanOrEqual(1);

    const row = await env.DB.prepare(
      `SELECT storage_bytes_used, file_count FROM workspaces WHERE id = ?`
    ).bind(WORKSPACE_A).first<{ storage_bytes_used: number; file_count: number }>();
    expect(row?.storage_bytes_used).toBe(800);
    expect(row?.file_count).toBe(2);
  });

  it("does not count soft-deleted files", async () => {
    // They released their quota at delete time, which is the customer-friendly
    // choice: you stop paying when you delete, not 24 hours later.
    await seedFile({ id: "fil_LIVE2", sizeBytes: 100 });
    await seedFile({ id: "fil_DEAD", sizeBytes: 900, status: "deleted", deletedAt: NOW - 1000 });

    await reconcileCounters(env.DB, NOW);
    const row = await env.DB.prepare(
      `SELECT storage_bytes_used, file_count FROM workspaces WHERE id = ?`
    ).bind(WORKSPACE_A).first<{ storage_bytes_used: number; file_count: number }>();
    expect(row?.storage_bytes_used).toBe(100);
    expect(row?.file_count).toBe(1);
  });

  it("leaves a correct counter untouched", async () => {
    await seedFile({ id: "fil_OK", sizeBytes: 250 });
    await env.DB.prepare(
      `UPDATE workspaces SET storage_bytes_used = 250, file_count = 1 WHERE id = ?`
    ).bind(WORKSPACE_A).run();

    const result = await reconcileCounters(env.DB, NOW);
    expect(result.workspacesCorrected).toBe(0);
  });

  it("recomputes from rows rather than trusting the counter", async () => {
    // The value you cannot use to detect that a counter drifted is the counter.
    await env.DB.prepare(
      `UPDATE workspaces SET storage_bytes_used = -5000, file_count = -3 WHERE id = ?`
    ).bind(WORKSPACE_A).run();

    await reconcileCounters(env.DB, NOW);
    const row = await env.DB.prepare(
      `SELECT storage_bytes_used, file_count FROM workspaces WHERE id = ?`
    ).bind(WORKSPACE_A).first<{ storage_bytes_used: number; file_count: number }>();
    expect(row?.storage_bytes_used).toBe(0);
    expect(row?.file_count).toBe(0);
  });

  it("does not leak one workspace's usage into another", async () => {
    await seedFile({ id: "fil_MINE", workspaceId: WORKSPACE_A, sizeBytes: 400 });
    await seedFile({ id: "fil_THEIRS", workspaceId: WORKSPACE_B, sizeBytes: 700 });

    await reconcileCounters(env.DB, NOW);
    const a = await env.DB.prepare(`SELECT storage_bytes_used AS b FROM workspaces WHERE id = ?`)
      .bind(WORKSPACE_A).first<{ b: number }>();
    const b = await env.DB.prepare(`SELECT storage_bytes_used AS b FROM workspaces WHERE id = ?`)
      .bind(WORKSPACE_B).first<{ b: number }>();
    expect(a?.b).toBe(400);
    expect(b?.b).toBe(700);
  });
});

async function orgCounters(): Promise<{ storage_bytes_used: number; file_count: number }> {
  const row = await env.DB.prepare(
    `SELECT storage_bytes_used, file_count FROM organizations WHERE id = ?`
  )
    .bind(ORG_ID)
    .first<{ storage_bytes_used: number; file_count: number }>();
  if (row === null) throw new Error("seed missing");
  return row;
}

/**
 * The account-level counters — the numbers the quota is actually decided from
 * since migration 0017.
 *
 * WORKSPACE_A and WORKSPACE_B share one organization, which is the whole
 * situation this change exists for: an account on a paid plan used to hold its
 * plan's storage *per workspace*, so owning a second workspace doubled the
 * allowance and pressing "New workspace" is free.
 */
describe("reconciling the billing account", () => {
  it("sums every workspace in the account, not just one", async () => {
    await seedFile({ id: "fil_A1", workspaceId: WORKSPACE_A, sizeBytes: 300 });
    await seedFile({ id: "fil_B1", workspaceId: WORKSPACE_B, sizeBytes: 700 });

    const result = await reconcileCounters(env.DB, NOW);
    expect(result.organizationsCorrected).toBeGreaterThanOrEqual(1);
    expect(await orgCounters()).toEqual({ storage_bytes_used: 1000, file_count: 2 });
  });

  it("counts only active rows, matching the workspace pass exactly", async () => {
    // A row marked `deleted` released its quota when the delete was accepted
    // and is waiting on the reaper. Counting it at the account level but not
    // the workspace level would make the two disagree by construction.
    await seedFile({ id: "fil_LIVE", workspaceId: WORKSPACE_A, sizeBytes: 100 });
    await seedFile({
      id: "fil_GONE",
      workspaceId: WORKSPACE_B,
      sizeBytes: 5000,
      status: "deleted",
      deletedAt: NOW - 1000,
    });

    await reconcileCounters(env.DB, NOW);
    expect(await orgCounters()).toEqual({ storage_bytes_used: 100, file_count: 1 });
  });

  it("derives the account from the files, never from the workspace counters", async () => {
    // The workspace pass is paginated, so summing the counters it has just
    // fixed would fold this run's unvisited workspaces - and any drift still
    // in them - into the number every write in the account is refused on.
    // Here WORKSPACE_A's own counter is left lying, and the account total must
    // still be the truth.
    await seedFile({ id: "fil_ONLY", workspaceId: WORKSPACE_A, sizeBytes: 250 });
    await env.DB.prepare(`UPDATE workspaces SET storage_bytes_used = ? WHERE id = ?`)
      .bind(999_999, WORKSPACE_A)
      .run();

    await reconcileCounters(env.DB, NOW);
    expect(await orgCounters()).toEqual({ storage_bytes_used: 250, file_count: 1 });
  });

  it("reports a clean account as checked but uncorrected", async () => {
    await seedFile({ id: "fil_C1", workspaceId: WORKSPACE_A, sizeBytes: 42 });
    await reconcileCounters(env.DB, NOW);

    const second = await reconcileCounters(env.DB, NOW);
    expect(second.organizationsChecked).toBeGreaterThanOrEqual(1);
    expect(second.organizationsCorrected).toBe(0);
  });
});

describe("the incremental counter writer", () => {
  it("moves the account and the workspace together", async () => {
    const db = createWorkspaceContext(env.DB, WORKSPACE_A);
    await db.counters.apply({ bytes: 500, files: 2 }, NOW);

    expect(await orgCounters()).toEqual({ storage_bytes_used: 500, file_count: 2 });

    // The second workspace's write lands on the same account, which is what
    // makes the allowance shared rather than multiplied.
    const other = createWorkspaceContext(env.DB, WORKSPACE_B);
    await other.counters.apply({ bytes: 250, files: 1 }, NOW);
    expect(await orgCounters()).toEqual({ storage_bytes_used: 750, file_count: 3 });
  });

  it("leaves the account alone for an egress-only delta", async () => {
    // Egress is a period counter on the workspace and does not move the
    // account's storage. Writing `organizations` on every download would be a
    // write per read for a number that did not change.
    const db = createWorkspaceContext(env.DB, WORKSPACE_A);
    await db.counters.apply({ egressBytes: 4096 }, NOW);
    expect(await orgCounters()).toEqual({ storage_bytes_used: 0, file_count: 0 });
  });

  it("never lets a decrement drive either row negative", async () => {
    const db = createWorkspaceContext(env.DB, WORKSPACE_A);
    await db.counters.apply({ bytes: 100, files: 1 }, NOW);
    await db.counters.apply({ bytes: -5000, files: -50 }, NOW);
    expect(await orgCounters()).toEqual({ storage_bytes_used: 0, file_count: 0 });
  });
});
