/**
 * The 30-day sweep behind admin deletion — 32 PART 7 and 11.
 *
 * The first test is the one that matters most, and it is about a default rather
 * than a behaviour: this job reports and does not delete unless explicitly
 * enabled. Dev holds weeks of test data, and a sweep shipped enabled would take
 * all of it on its first tick. The same mistake was available in
 * `expireUnclaimedWorkspaces` and was avoided the same way; this pins it so a
 * later edit cannot quietly flip the default.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_PURGE_WINDOW_MS, purgeAdminDeleted } from "../src/jobs/admin-purge";
import { NOW, WORKSPACE_A, seedTwoWorkspaces } from "./helpers";

const ORG_ID = "org_TESTORG";
const LONG_AGO = NOW - ADMIN_PURGE_WINDOW_MS - 1000;
const YESTERDAY = NOW - 24 * 60 * 60 * 1000;

async function workspaceRow(id: string) {
  return env.DB.prepare(`SELECT id, status, deleted_at AS deletedAt FROM workspaces WHERE id = ?`)
    .bind(id)
    .first<{ id: string; status: string; deletedAt: number | null }>();
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  await env.DB.prepare(`UPDATE workspaces SET deleted_at = NULL, status = 'active'`).run();
  await env.DB.prepare(`UPDATE users SET deleted_at = NULL, disabled_at = NULL`).run();
  await env.DB.prepare(
    `UPDATE organizations SET stripe_customer_id = NULL, billing_status = 'active' WHERE id = ?`
  )
    .bind(ORG_ID)
    .run();
});

describe("what it does by default", () => {
  it("reports and deletes nothing", async () => {
    await env.DB.prepare(`UPDATE workspaces SET status = 'deleted', deleted_at = ? WHERE id = ?`)
      .bind(LONG_AGO, WORKSPACE_A)
      .run();

    const result = await purgeAdminDeleted(env.DB, env.FILES, NOW);

    expect(result.dryRun).toBe(true);
    expect(result.workspaceCandidates).toBe(1);
    expect(result.workspacesPurged).toBe(0);
    // Still there, still restorable.
    expect(await workspaceRow(WORKSPACE_A)).not.toBeNull();
  });

  it("leaves anything still inside its window alone, even when enabled", async () => {
    await env.DB.prepare(`UPDATE workspaces SET status = 'deleted', deleted_at = ? WHERE id = ?`)
      .bind(YESTERDAY, WORKSPACE_A)
      .run();

    const result = await purgeAdminDeleted(env.DB, env.FILES, NOW, false);

    expect(result.workspaceCandidates).toBe(0);
    expect(await workspaceRow(WORKSPACE_A)).not.toBeNull();
  });
});

describe("live billing stops it", () => {
  it("skips a workspace whose organization still has an uncancelled subscription", async () => {
    // The delete endpoint already blocks on this, but a subscription can be
    // created - or a block lifted - in the thirty days between the two, and a
    // cascade is not the place to discover that.
    await env.DB.prepare(
      `UPDATE organizations SET stripe_customer_id = 'cus_X', billing_status = 'active' WHERE id = ?`
    )
      .bind(ORG_ID)
      .run();
    await env.DB.prepare(`UPDATE workspaces SET status = 'deleted', deleted_at = ? WHERE id = ?`)
      .bind(LONG_AGO, WORKSPACE_A)
      .run();

    const result = await purgeAdminDeleted(env.DB, env.FILES, NOW, false);

    expect(result.skippedForBilling).toBeGreaterThan(0);
    expect(result.workspacesPurged).toBe(0);
    expect(await workspaceRow(WORKSPACE_A)).not.toBeNull();
  });

  it("proceeds once the subscription is cancelled", async () => {
    await env.DB.prepare(
      `UPDATE organizations SET stripe_customer_id = 'cus_X', billing_status = 'canceled' WHERE id = ?`
    )
      .bind(ORG_ID)
      .run();
    await env.DB.prepare(`UPDATE workspaces SET status = 'deleted', deleted_at = ? WHERE id = ?`)
      .bind(LONG_AGO, WORKSPACE_A)
      .run();

    const result = await purgeAdminDeleted(env.DB, env.FILES, NOW, false);

    expect(result.workspacesPurged).toBe(1);
    expect(await workspaceRow(WORKSPACE_A)).toBeNull();
  });
});

describe("a purged user", () => {
  it("is scrubbed but never removed, so the audit trail still resolves them", async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, email, firebase_uid, is_provisional, session_revoked_after,
                          created_at, updated_at, deleted_at)
       VALUES ('usr_GONE', 'gone@example.com', 'uid-gone', 0, 0, ?, ?, ?)`
    )
      .bind(NOW, NOW, LONG_AGO)
      .run();

    const result = await purgeAdminDeleted(env.DB, env.FILES, NOW, false);
    expect(result.usersScrubbed).toBe(1);

    const row = await env.DB.prepare(
      `SELECT id, email, firebase_uid AS firebaseUid, deleted_at AS deletedAt
         FROM users WHERE id = 'usr_GONE'`
    ).first<{ id: string; email: string; firebaseUid: string | null; deletedAt: number | null }>();

    // The row is what an audit_events actor id resolves to. Deleting it would
    // leave every historical action attributed to nothing at all.
    expect(row).not.toBeNull();
    expect(row?.firebaseUid).toBeNull();
    expect(row?.email).toBe("deleted-usr_GONE@deleted.invalid");
    // Still flagged deleted, so the auth chain keeps refusing them.
    expect(row?.deletedAt).toBe(LONG_AGO);
  });

  it("does not release the address for somebody else to register", async () => {
    // users.email is NOT NULL UNIQUE, so the scrub cannot blank it - and should
    // not, because releasing it would let another account inherit the
    // confusion. .invalid is RFC 2606's and can never receive mail.
    await env.DB.prepare(
      `INSERT INTO users (id, email, is_provisional, session_revoked_after,
                          created_at, updated_at, deleted_at)
       VALUES ('usr_GONE2', 'gone2@example.com', 0, 0, ?, ?, ?)`
    )
      .bind(NOW, NOW, LONG_AGO)
      .run();

    await purgeAdminDeleted(env.DB, env.FILES, NOW, false);

    const row = await env.DB.prepare(`SELECT email FROM users WHERE id = 'usr_GONE2'`).first<{
      email: string;
    }>();
    expect(row?.email).toMatch(/@deleted\.invalid$/);
  });
});
