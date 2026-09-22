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
import { sweepPendingDeletions, releaseAddress } from "../src/jobs/pending-deletions";
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

describe("releasing the identity and the address", () => {
  async function queued(id: string, email: string, purgeAfter: number): Promise<void> {
    await seedDeletableUser(id, email);
    await env.DB.prepare(
      `UPDATE users SET deleted_at = ?, purge_after = ? WHERE id = ?`
    )
      .bind(NOW, purgeAfter, id)
      .run();
  }

  it("skips entirely when Firebase is not configured", async () => {
    // Not a partial run. Scrubbing the address here would free it in our
    // database and leave it claimed in Firebase, so the person's next signup
    // fails on EMAIL_EXISTS with nothing on our side explaining why. The two
    // move together or neither does.
    await queued("usr_PURGE5", "erin@example.com", NOW - 1);

    const result = await sweepPendingDeletions(env.DB, env.FILES, NOW, {
      dryRun: false,
      identity: { config: null, kv: env.CACHE },
    });

    expect(result.identitySkipped).toBe(true);
    expect(result.identitiesReleased).toBe(0);

    const row = await readUser("usr_PURGE5");
    expect(row?.email).toBe("erin@example.com");
    expect(row?.firebase_uid).toBe("fb-usr_PURGE5");
  });

  it("leaves an account whose window has not passed", async () => {
    await queued("usr_PURGE6", "frank@example.com", NOW + 60_000);

    const result = await sweepPendingDeletions(env.DB, env.FILES, NOW, {
      dryRun: false,
      identity: { config: null, kv: env.CACHE },
    });

    // Not even skipped - there was nothing due to skip.
    expect(result.identitySkipped).toBe(false);
    expect(result.identitiesReleased).toBe(0);
  });

  it("counts what it would release on a dry run, and releases nothing", async () => {
    await queued("usr_PURGE7", "grace@example.com", NOW - 1);

    const result = await sweepPendingDeletions(env.DB, env.FILES, NOW, {
      identity: { config: null, kv: env.CACHE },
    });

    expect(result.dryRun).toBe(true);
    expect(await readUser("usr_PURGE7")).toMatchObject({ email: "grace@example.com" });
  });

  it("ignores an account that was never deleted", async () => {
    // purge_after without deleted_at is not a state the product can reach, but
    // the query guards on both rather than trusting that - the consequence of
    // being wrong is deleting a live person's identity.
    await seedDeletableUser("usr_PURGE8", "heidi@example.com");
    await env.DB.prepare(`UPDATE users SET purge_after = ? WHERE id = ?`)
      .bind(NOW - 1, "usr_PURGE8")
      .run();

    const result = await sweepPendingDeletions(env.DB, env.FILES, NOW, {
      dryRun: false,
      identity: { config: null, kv: env.CACHE },
    });

    expect(result.identitySkipped).toBe(false);
    expect(result.identitiesReleased).toBe(0);
  });
});

describe("coming back afterwards", () => {
  /** What a fresh signup does: a new row, new uid, same address. */
  async function signUpAgain(id: string, email: string): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO users (id, email, firebase_uid, is_provisional, session_revoked_after,
                          created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)`
    )
      .bind(id, email, `fb-new-${id}`, NOW, NOW)
      .run();
  }

  it("blocks a new signup while the window is open, and allows it after", async () => {
    // The whole re-join story in one test, and the defect it was found in:
    // `users.email` is NOT NULL UNIQUE, so a tombstone holding the real
    // address means a person's own account closure locks them out of their own
    // email permanently. Their next signup dies on the unique index with an
    // error they cannot act on.
    await seedDeletableUser("usr_PURGE9", "ivan@example.com");
    await access().softDelete("usr_PURGE9", "a reason long enough to be one", { revokeKeys: false });

    // During the window the address is still held - deliberately, because the
    // account is still being emailed. A signup now is refused, and the refusal
    // is correct: inside a recovery window somebody should be recovering, not
    // starting over.
    await expect(signUpAgain("usr_RETURN1", "ivan@example.com")).rejects.toThrow();

    // The sweep releases it at the end, with the identity.
    await releaseAddress(env.DB, "usr_PURGE9", NOW + ACCOUNT_PURGE_TTL_MS);

    // And now they can come back.
    await expect(signUpAgain("usr_RETURN2", "ivan@example.com")).resolves.toBeUndefined();
  });

  it("gives the returning person a genuinely new account", async () => {
    // Nothing is recovered. The tombstone keeps its own id and its scrubbed
    // address; the new row is a different account that merely shares an email.
    await seedDeletableUser("usr_PURGE10", "judy@example.com");
    await access().softDelete("usr_PURGE10", "a reason long enough to be one", { revokeKeys: false });
    await releaseAddress(env.DB, "usr_PURGE10", NOW + ACCOUNT_PURGE_TTL_MS);
    await signUpAgain("usr_RETURN3", "judy@example.com");

    const tomb = await readUser("usr_PURGE10");
    expect(tomb?.email).toBe("deleted-usr_PURGE10@agentdisk.invalid");
    expect(tomb?.deleted_at).not.toBeNull();
    expect(tomb?.firebase_uid).toBeNull();

    const fresh = await readUser("usr_RETURN3");
    expect(fresh?.email).toBe("judy@example.com");
    expect(fresh?.deleted_at).toBeNull();
  });
});
