/**
 * Purge and reconciliation — 05 PART 12.5, 10.8.
 *
 * These close a real gap rather than guard a hypothetical one: nothing removed
 * soft-deleted R2 objects, so every deleted file was still occupying storage
 * this product pays for and no longer charges for. And the usage counters are
 * maintained incrementally, which means they drift, and a customer billed
 * against a drifted counter is either overcharged or storing for free.
 *
 * The grace period is the part worth being careful about. Purging one minute
 * early destroys a file somebody could still have restored, and no test after
 * the fact brings it back.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { purgeExpiredFiles, reconcileCounters, PURGE_GRACE_MS } from "../src/jobs/purge";
import { NOW, WORKSPACE_A, WORKSPACE_B, seedTwoWorkspaces } from "./helpers";

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
});

describe("purge", () => {
  it("removes a file whose grace period has passed", async () => {
    await seedFile({ id: "fil_OLD", status: "deleted", deletedAt: NOW - PURGE_GRACE_MS - 1000 });

    const result = await purgeExpiredFiles(env.DB, env.FILES, NOW);
    expect(result).toMatchObject({ examined: 1, rowsDeleted: 1, failed: 0 });
    expect(await fileExists("fil_OLD")).toBe(false);
    expect(await env.FILES.head(`tenant/${WORKSPACE_A}/fil_OLD`)).toBeNull();
  });

  it("leaves a file still inside its grace period alone", async () => {
    // Purging early destroys something somebody could still restore, and no
    // amount of noticing afterwards brings it back.
    await seedFile({ id: "fil_RECENT", status: "deleted", deletedAt: NOW - 60_000 });

    const result = await purgeExpiredFiles(env.DB, env.FILES, NOW);
    expect(result.examined).toBe(0);
    expect(await fileExists("fil_RECENT")).toBe(true);
    expect(await env.FILES.head(`tenant/${WORKSPACE_A}/fil_RECENT`)).not.toBeNull();
  });

  it("does not touch active files", async () => {
    await seedFile({ id: "fil_LIVE", status: "active" });
    await purgeExpiredFiles(env.DB, env.FILES, NOW);
    expect(await fileExists("fil_LIVE")).toBe(true);
  });

  it("purges across workspaces in one sweep", async () => {
    // It is a platform job, not a tenant-scoped one - which is exactly why it
    // lives outside the workspace-scoped repositories.
    await seedFile({ id: "fil_A", workspaceId: WORKSPACE_A, status: "deleted", deletedAt: NOW - PURGE_GRACE_MS - 1 });
    await seedFile({ id: "fil_B", workspaceId: WORKSPACE_B, status: "deleted", deletedAt: NOW - PURGE_GRACE_MS - 1 });

    const result = await purgeExpiredFiles(env.DB, env.FILES, NOW);
    expect(result.rowsDeleted).toBe(2);
  });

  it("treats an already-missing object as success", async () => {
    // A retry after a partial run must converge, not fail forever. The desired
    // state is "no object", and it already holds.
    await seedFile({ id: "fil_GONE", status: "deleted", deletedAt: NOW - PURGE_GRACE_MS - 1 });
    await env.FILES.delete(`tenant/${WORKSPACE_A}/fil_GONE`);

    const result = await purgeExpiredFiles(env.DB, env.FILES, NOW);
    expect(result.failed).toBe(0);
    expect(await fileExists("fil_GONE")).toBe(false);
  });

  it("is bounded, so one run cannot exceed its budget", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedFile({ id: `fil_M${i}`, status: "deleted", deletedAt: NOW - PURGE_GRACE_MS - 1 });
    }
    const result = await purgeExpiredFiles(env.DB, env.FILES, NOW, 2);
    expect(result.examined).toBe(2);
    expect(result.rowsDeleted).toBe(2);

    // The rest stay for the next run rather than being lost.
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM files`).first<{ n: number }>();
    expect(left?.n).toBe(3);
  });

  it("takes the oldest first, so a backlog drains in order", async () => {
    await seedFile({ id: "fil_NEWER", status: "deleted", deletedAt: NOW - PURGE_GRACE_MS - 1000 });
    await seedFile({ id: "fil_OLDER", status: "deleted", deletedAt: NOW - PURGE_GRACE_MS - 99_000 });

    await purgeExpiredFiles(env.DB, env.FILES, NOW, 1);
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
