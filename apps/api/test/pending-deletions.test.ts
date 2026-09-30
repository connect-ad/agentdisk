/**
 * The seven-day sweep that removes the bytes a hard-deleted workspace left.
 *
 * What is worth proving here is the direction of every failure, because this
 * job's whole job is destroying data nobody can get back:
 *
 *  - it does not delete before the due date, unless explicitly forced
 *  - it does not delete at all unless deletion has been switched on
 *  - a run that deleted nothing still reports what it saw
 *  - a failure charges an attempt and leaves the row, rather than losing it
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sweepPendingDeletions, pendingDeletionEnabled } from "../src/jobs/pending-deletions";

const NOW = 1_780_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

async function reset(): Promise<void> {
  await env.DB.prepare(`DELETE FROM pending_deletions`).run();
  await env.DB.prepare(`DELETE FROM job_runs`).run();
}

async function queue(
  fileId: string,
  dueAt: number,
  sizeBytes = 10
): Promise<string> {
  const key = `tenant/ws_GONE/${fileId}`;
  await env.FILES.put(key, "bytes");
  await env.DB.prepare(
    `INSERT INTO pending_deletions
       (file_id, r2_object_key, size_bytes, path, name, workspace_id, workspace_name,
        org_id, deleted_by, source, marked_at, due_at, attempts, last_error)
     VALUES (?, ?, ?, '/a.txt', 'a.txt', 'ws_GONE', 'Gone', 'org_GONE', 'usr_X',
             'workspace_delete', ?, ?, 0, NULL)`
  )
    .bind(fileId, key, sizeBytes, NOW - DAY, dueAt)
    .run();
  return key;
}

async function countPending(): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM pending_deletions`).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(reset);

describe("the enable flag", () => {
  it("is off for anything but the exact string", () => {
    // An unset, empty or misspelled value must not delete anything.
    expect(pendingDeletionEnabled({})).toBe(false);
    expect(pendingDeletionEnabled({ PENDING_DELETION_ENABLED: "" })).toBe(false);
    expect(pendingDeletionEnabled({ PENDING_DELETION_ENABLED: "TRUE" })).toBe(false);
    expect(pendingDeletionEnabled({ PENDING_DELETION_ENABLED: "yes" })).toBe(false);
    expect(pendingDeletionEnabled({ PENDING_DELETION_ENABLED: "true" })).toBe(true);
  });
});

describe("sweepPendingDeletions", () => {
  it("defaults to reporting, and leaves every byte where it is", async () => {
    const key = await queue("fil_DRY", NOW - 1);

    // No options at all: the signature's own default has to be the safe one,
    // because that is what a caller who forgets gets.
    const result = await sweepPendingDeletions(env.DB, env.FILES, NOW);

    expect(result.dryRun).toBe(true);
    expect(result.examined).toBe(1);
    expect(result.rowsDeleted).toBe(0);
    expect(await env.FILES.get(key)).not.toBeNull();
    expect(await countPending()).toBe(1);
  });

  it("still writes a job_runs row for a dry run, with what it would have done", async () => {
    await queue("fil_REPORT", NOW - 1, 4096);

    const result = await sweepPendingDeletions(env.DB, env.FILES, NOW);

    const run = await env.DB.prepare(`SELECT * FROM job_runs WHERE id = ?`)
      .bind(result.runId)
      .first<{ dry_run: number; examined: number; bytes_freed: number; finished_at: number | null }>();

    // A run you cannot see is not a report.
    expect(run?.dry_run).toBe(1);
    expect(run?.examined).toBe(1);
    expect(run?.bytes_freed).toBe(4096);
    expect(run?.finished_at).not.toBeNull();
  });

  it("deletes the object and then the row, once enabled", async () => {
    const key = await queue("fil_REAL", NOW - 1, 64);

    const result = await sweepPendingDeletions(env.DB, env.FILES, NOW, { dryRun: false });

    expect(result.objectsDeleted).toBe(1);
    expect(result.rowsDeleted).toBe(1);
    expect(result.bytesFreed).toBe(64);
    expect(await env.FILES.get(key)).toBeNull();
    expect(await countPending()).toBe(0);
  });

  it("will not touch a row before its due date", async () => {
    const key = await queue("fil_EARLY", NOW + DAY);

    const result = await sweepPendingDeletions(env.DB, env.FILES, NOW, { dryRun: false });

    expect(result.examined).toBe(0);
    expect(await env.FILES.get(key)).not.toBeNull();
    expect(await countPending()).toBe(1);
  });

  it("takes an undue row only when forced", async () => {
    // The "a customer has asked for their data to be gone today" case, and the
    // one control here that destroys something ahead of its promised schedule.
    const key = await queue("fil_FORCED", NOW + 6 * DAY);

    const result = await sweepPendingDeletions(env.DB, env.FILES, NOW, {
      dryRun: false,
      force: true,
    });

    expect(result.rowsDeleted).toBe(1);
    expect(await env.FILES.get(key)).toBeNull();
  });

  it("treats an object that is already gone as success", async () => {
    // R2's delete is idempotent and the desired state is "no object", which a
    // retry that finds nothing has already reached.
    const key = await queue("fil_ABSENT", NOW - 1);
    await env.FILES.delete(key);

    const result = await sweepPendingDeletions(env.DB, env.FILES, NOW, { dryRun: false });

    expect(result.failed).toBe(0);
    expect(result.rowsDeleted).toBe(1);
    expect(await countPending()).toBe(0);
  });

  it("drains oldest first, so a backlog cannot starve its earliest rows", async () => {
    await queue("fil_NEW", NOW - 1);
    await queue("fil_OLD", NOW - 5 * DAY);

    const result = await sweepPendingDeletions(env.DB, env.FILES, NOW, {
      dryRun: false,
      limit: 1,
    });

    expect(result.rowsDeleted).toBe(1);
    const left = await env.DB.prepare(`SELECT file_id FROM pending_deletions`).first<{ file_id: string }>();
    expect(left?.file_id).toBe("fil_NEW");
  });

  it("charges an attempt and keeps the row when R2 refuses", async () => {
    await queue("fil_BROKEN", NOW - 1);
    const failing = {
      delete: async () => {
        throw new Error("R2 said no");
      },
    } as unknown as R2Bucket;

    const result = await sweepPendingDeletions(env.DB, failing, NOW, { dryRun: false });

    expect(result.failed).toBe(1);
    expect(result.rowsDeleted).toBe(0);

    // Left for the next run rather than lost, with the reason visible to an
    // operator - a row whose attempts climb without bound is their call.
    const row = await env.DB.prepare(
      `SELECT attempts, last_error FROM pending_deletions WHERE file_id = 'fil_BROKEN'`
    ).first<{ attempts: number; last_error: string }>();
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toMatch(/R2 said no/);
  });

  it("records the admin actor when a person triggers it", async () => {
    await queue("fil_ADMIN", NOW - 1);

    const result = await sweepPendingDeletions(env.DB, env.FILES, NOW, {
      dryRun: false,
      trigger: "admin",
      actorId: "stf_ABC",
      actorEmail: "ops@example.com",
    });

    const run = await env.DB.prepare(`SELECT trigger, actor_id, actor_email FROM job_runs WHERE id = ?`)
      .bind(result.runId)
      .first<{ trigger: string; actor_id: string; actor_email: string }>();

    expect(run?.trigger).toBe("admin");
    expect(run?.actor_id).toBe("stf_ABC");
    expect(run?.actor_email).toBe("ops@example.com");
  });
});
