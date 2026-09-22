/**
 * What a deleted account keeps, and for how long.
 *
 * Two facts have to hold together and an earlier draft of this design broke
 * them against each other. The email address must be **released eventually**,
 * or `users.email NOT NULL UNIQUE` means a person's own deletion locks them out
 * of their own address for good. And it must **survive the delete request**, or
 * every message the account is still owed — the warnings, the confirmation that
 * its bytes are gone — has nowhere to go.
 *
 * So the delete queues both irreversible halves and releases neither. The sweep
 * does them together seven days later. These tests pin the first half of that;
 * `pending-deletions.test.ts` pins the second.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_PURGE_TTL_MS } from "../src/db/workspace-cascade";
import { NOW, ORG_ID, seedTwoWorkspaces } from "./helpers";
import { AdminUserAccess } from "../src/admin/users-access";
import type { AdminUser } from "../src/admin/access";

const ADMIN: AdminUser = {
  id: "adm_TEST",
  email: "admin@agentdisk.io",
  role: "admin",
  disabledAt: null,
};

function access(): AdminUserAccess {
  return new AdminUserAccess(env.DB, ADMIN, "req_TEST", NOW, "203.0.113.1");
}

async function seedDeletableUser(id: string, email: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, email, firebase_uid, is_provisional, session_revoked_after,
                        created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, ?, ?)`
  )
    .bind(id, email, `fb-${id}`, NOW, NOW)
    .run();
}

async function readUser(id: string) {
  return env.DB.prepare(
    `SELECT email, deleted_at, purge_after, firebase_uid FROM users WHERE id = ?`
  )
    .bind(id)
    .first<{
      email: string;
      deleted_at: number | null;
      purge_after: number | null;
      firebase_uid: string | null;
    }>();
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  await env.DB.prepare(`DELETE FROM users WHERE id LIKE 'usr_PURGE%'`).run();
  await env.DB.prepare(`DELETE FROM admin_actions`).run();
});

describe("deleting an account", () => {
  it("queues the purge instead of performing it", async () => {
    await seedDeletableUser("usr_PURGE1", "alice@example.com");

    await access().softDelete("usr_PURGE1", "a reason long enough to be one", { revokeKeys: false });

    const row = await readUser("usr_PURGE1");
    expect(row?.deleted_at).toBe(NOW);
    expect(row?.purge_after).toBe(NOW + ACCOUNT_PURGE_TTL_MS);
  });

  it("keeps the address mailable through the whole window", async () => {
    // The defect this exists for. Releasing the address in the delete request
    // leaves the warnings and the deletion-confirmed message with nowhere to
    // send. It is released by the sweep, at the end, with the identity.
    await seedDeletableUser("usr_PURGE2", "bob@example.com");

    await access().softDelete("usr_PURGE2", "a reason long enough to be one", { revokeKeys: false });

    const row = await readUser("usr_PURGE2");
    expect(row?.email).toBe("bob@example.com");
    expect(row?.firebase_uid).toBe("fb-usr_PURGE2");
  });

  it("leaves the row itself standing, as a tombstone", async () => {
    // `audit_events.actor_id` resolves to this row, and `resolveVerifiedUser`
    // reads `deleted_at` to refuse tokens minted before the account went -
    // those stay valid for up to an hour after Firebase disables the identity,
    // so our own row is the only thing that can refuse them in that window.
    await seedDeletableUser("usr_PURGE3", "carol@example.com");

    await access().softDelete("usr_PURGE3", "a reason long enough to be one", { revokeKeys: false });

    expect(await readUser("usr_PURGE3")).not.toBeNull();
  });

  it("does not re-queue an account that is already deleted", async () => {
    // The UPDATE is guarded on `deleted_at IS NULL`, so a second delete cannot
    // move the purge date and quietly extend the window.
    await seedDeletableUser("usr_PURGE4", "dave@example.com");
    await access().softDelete("usr_PURGE4", "a reason long enough to be one", { revokeKeys: false });
    const first = await readUser("usr_PURGE4");

    const later = new AdminUserAccess(env.DB, ADMIN, "req_TEST", NOW + 60_000, null);
    await later.softDelete("usr_PURGE4", "a reason long enough to be one", { revokeKeys: false })
      .catch(() => undefined);

    expect((await readUser("usr_PURGE4"))?.purge_after).toBe(first?.purge_after);
  });
});
