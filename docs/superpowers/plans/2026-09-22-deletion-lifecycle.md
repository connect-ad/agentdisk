# Deletion Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make deletion actually delete, make a deleted account able to return, and give staff a way to see and run the sweep.

**Architecture:** The deferred-deletion mechanism is already built — credentials die in the request, file rows move to `pending_deletions`, a sweep erases the bytes seven days later. This plan turns that sweep on, extends it to also delete the Firebase identity, frees the email address so a person can sign up again, removes the restore path that can resurrect a gutted account, adds self-service account deletion, and surfaces the queue in the staff console.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), R2, Vitest with `@cloudflare/vitest-pool-workers`, Preact/React SPAs, Stripe SDK, Firebase Identity Toolkit Admin API.

**Spec:** `docs/superpowers/specs/2026-09-22-deletion-lifecycle-design.md`

## Global Constraints

- **Migrations are additive and backward-compatible.** They run *before* the code deploy, so new code must never meet an old schema and old code must survive a new one.
- **Next migration number is `0019`.** `0017` is used twice (`0017_org_usage_counters.sql`, `0017_pending_deletions.sql`) — do not add a third.
- **FK ordering is load-bearing.** SQLite checks foreign keys immediately and deletes rows within a statement in arbitrary order. Clear inbound references to NULL before deleting, and delete child-first. See `db/workspace-cascade.ts`.
- **R2 before D1, always.** The rows are the only record of which objects exist; losing them first orphans bytes nothing can find.
- **Destructive jobs default to reporting.** `dryRun ?? true`, gated on an env flag. Never invert this default.
- **Every staff action is audited**, including refusals. Extend `AuditedAdminAccess`; never write a staff mutation outside it.
- **One console role.** `requireRole("admin", ...)` is the only valid call; `support` and `super_admin` no longer exist.
- **`users.email` is `NOT NULL UNIQUE`.** Any row that keeps a real address blocks that person from ever signing up again.
- **Scrubbed addresses use `.invalid`** (RFC 2606): `deleted-{userId}@agentdisk.invalid`, matching `db/bootstrap.ts`.
- **Test commands:** `cd apps/api && npx vitest run` and `npx tsc --noEmit`; `cd apps/web && npx vitest run`; `cd apps/admin && npx vitest run && npm run build`.

---

### Task 1: Turn the sweep on, and move it to weekly

The sweep is fully built and has never deleted anything: `dryRun ?? true` with `PENDING_DELETION_ENABLED` unset in both environments. Storage is paid for indefinitely on files customers deleted.

**Files:**
- Modify: `apps/api/wrangler.toml` (both `[env.dev]` and `[env.prod]` `vars` and `crons`)
- Modify: `apps/api/src/index.ts` — the scheduled handler's sweep block
- Test: `apps/api/test/pending-deletions.test.ts`

**Interfaces:**
- Consumes: `sweepPendingDeletions(db, files, now, options): Promise<SweepResult>` and `pendingDeletionEnabled(env)` from `src/jobs/pending-deletions.ts` — both already exported, unchanged by this task.
- Produces: nothing new. Behaviour change only.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/pending-deletions.test.ts
it("deletes the object and the row once the flag is on", async () => {
  await seedPending({ id: "fil_DUE", dueAt: NOW - 1000, objectKey: "tenant/ws_A/fil_DUE" });
  await env.FILES.put("tenant/ws_A/fil_DUE", new Uint8Array(10));

  const result = await sweepPendingDeletions(env.DB, env.FILES, NOW, { dryRun: false });

  expect(result.objectsDeleted).toBe(1);
  expect(result.rowsDeleted).toBe(1);
  expect(await env.FILES.head("tenant/ws_A/fil_DUE")).toBeNull();
});

it("still reports and deletes nothing when the flag is off", async () => {
  await seedPending({ id: "fil_DUE2", dueAt: NOW - 1000, objectKey: "tenant/ws_A/fil_DUE2" });
  await env.FILES.put("tenant/ws_A/fil_DUE2", new Uint8Array(10));

  const result = await sweepPendingDeletions(env.DB, env.FILES, NOW);

  expect(result.dryRun).toBe(true);
  expect(result.objectsDeleted).toBe(0);
  expect(await env.FILES.head("tenant/ws_A/fil_DUE2")).not.toBeNull();
});
```

- [ ] **Step 2: Run it and confirm the first fails**

Run: `cd apps/api && npx vitest run test/pending-deletions.test.ts`
Expected: the `dryRun: false` case FAILS if the sweep does not honour the option; the flag-off case should already PASS. If both pass, the job is correct and only configuration is missing — proceed to Step 3 regardless.

- [ ] **Step 3: Enable the flag and move the cron to weekly**

In `apps/api/wrangler.toml`, add `PENDING_DELETION_ENABLED = "true"` to the `vars` of **`[env.dev]` only**. Leave prod `"false"` — prod has never been applied, and the first prod deploy must print a list before it erases anything.

Change both `crons` entries from `["17 * * * *"]` to `["17 3 * * 0"]` — 03:17 on Sundays.

```toml
# A weekly sweep for a seven-day window. Hourly gave 168 chances to do
# nothing; the console's run-now button covers the cases where waiting is
# wrong, which is what the cadence was really protecting against.
crons = ["17 3 * * 0"]
```

- [ ] **Step 4: Run the suite**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/wrangler.toml apps/api/test/pending-deletions.test.ts
git commit -m "Enable the pending-deletion sweep in dev, weekly"
```

---

### Task 2: Free the email address on deletion

`users.email` is `NOT NULL UNIQUE` and the delete never touches it, so a returning customer's signup dies on the unique index.

**Files:**
- Create: `apps/api/migrations/0019_account_purge.sql`
- Modify: `apps/api/src/admin/users-access.ts` — the `UPDATE users SET deleted_at` statement (~line 367)
- Test: `apps/api/test/admin-users.test.ts` (or the existing file covering `AdminUserAccess`)

**Interfaces:**
- Produces: `users.purge_after INTEGER NULL` — the moment the Firebase identity becomes eligible for deletion. Task 3 reads it.
- Produces: scrubbed address format `deleted-{userId}@agentdisk.invalid`, relied on by Task 5's re-join test.

- [ ] **Step 1: Write the failing test**

```ts
it("frees the email address so the person can sign up again", async () => {
  await seedUser({ id: "usr_GONE", email: "alice@example.com", firebaseUid: "fb-alice" });

  await access().deleteUser("usr_GONE", "a reason long enough to be one");

  const row = await env.DB.prepare(`SELECT email, purge_after FROM users WHERE id = ?`)
    .bind("usr_GONE").first<{ email: string; purge_after: number | null }>();

  // The address is released, and released to something that can never
  // resolve or receive mail (RFC 2606).
  expect(row?.email).toBe("deleted-usr_GONE@agentdisk.invalid");
  expect(row?.purge_after).toBeGreaterThan(NOW);

  // And the row survives, because audit_events.actor_id points at it.
  expect(row).not.toBeNull();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run test/admin-users.test.ts -t "frees the email"`
Expected: FAIL — `expected 'alice@example.com' to be 'deleted-usr_GONE@agentdisk.invalid'`

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/migrations/0019_account_purge.sql
-- When a deleted account's Firebase identity becomes eligible for deletion.
--
-- The identity cannot go in the request. `resolveVerifiedUser` refuses a token
-- by reading `users.deleted_at` as a FIRST-PARTY check, before asking Firebase
-- anything, precisely so that deletion does not depend on a third party's side
-- effect having succeeded. That check needs the row, and the row is what makes
-- the seven-day window observable. So the identity is queued here and removed
-- by the same sweep that erases the bytes.
--
-- NULL means "not queued": every row that predates this column, and every live
-- account.
ALTER TABLE users ADD COLUMN purge_after INTEGER;

CREATE INDEX idx_users_purge_after ON users(purge_after)
  WHERE purge_after IS NOT NULL;
```

- [ ] **Step 4: Scrub the address in the delete**

In `apps/api/src/admin/users-access.ts`, replace the delete statement:

```ts
    // The address is released, not kept. `users.email` is NOT NULL UNIQUE, so
    // a tombstone holding the real address means the person can never sign up
    // again - their own deletion locks them out of their own email for good.
    // `.invalid` is reserved by RFC 2606 and can never resolve or receive
    // mail; `db/bootstrap.ts` uses the same pattern for provisional owners.
    //
    // The row itself stays: `audit_events.actor_id` resolves to it, and
    // `resolveVerifiedUser` reads `deleted_at` to refuse tokens minted before
    // the account went, which stay valid for up to an hour.
    const result = await this.db
      .prepare(
        `UPDATE users
            SET deleted_at = ?, session_revoked_after = ?, updated_at = ?,
                email = ?, purge_after = ?
          WHERE id = ? AND deleted_at IS NULL`
      )
      .bind(
        this.now,
        this.now,
        this.now,
        `deleted-${userId}@agentdisk.invalid`,
        this.now + ACCOUNT_PURGE_TTL_MS,
        userId
      )
      .run();
```

Add the constant beside `PENDING_DELETION_TTL_MS` in `apps/api/src/db/workspace-cascade.ts` and import it:

```ts
/** Matches PENDING_DELETION_TTL_MS deliberately: one retention window in the
 *  product, not two. */
export const ACCOUNT_PURGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: PASS. If a test asserted the old email survived deletion, it was asserting the bug — update it and say so in the commit.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/0019_account_purge.sql apps/api/src/admin/users-access.ts \
        apps/api/src/db/workspace-cascade.ts apps/api/test/admin-users.test.ts
git commit -m "Release the email address when an account is deleted"
```

---

### Task 3: Delete the Firebase identity instead of disabling it

A disabled identity still owns its address: the person can neither sign in (disabled) nor sign up (`EMAIL_EXISTS`).

**Files:**
- Modify: `apps/api/src/auth/firebase-admin.ts` — add `deleteFirebaseUser` beside `setFirebaseUserDisabled`
- Modify: `apps/api/src/jobs/pending-deletions.ts` — sweep queued identities
- Test: `apps/api/test/pending-deletions.test.ts`

**Interfaces:**
- Consumes: `users.purge_after` from Task 2; `getAccessToken(config)` and `readFirebaseAdminConfig(env)`, both already exported from `auth/firebase-admin.ts`.
- Produces: `deleteFirebaseUser(config, uid): Promise<boolean>` — `true` when deleted or already absent, `false` when Firebase is unconfigured.
- Produces: `SweepResult.identitiesDeleted: number`, read by Task 6's console screen.

- [ ] **Step 1: Write the failing test**

```ts
it("deletes the Firebase identity once its window has passed", async () => {
  await seedUser({
    id: "usr_DUE", email: "deleted-usr_DUE@agentdisk.invalid",
    firebaseUid: "fb-due", deletedAt: NOW - 1000, purgeAfter: NOW - 1
  });

  const result = await sweepPendingDeletions(env.DB, env.FILES, NOW, { dryRun: false });

  expect(result.identitiesDeleted).toBe(1);

  const row = await env.DB.prepare(`SELECT firebase_uid, purge_after FROM users WHERE id = ?`)
    .bind("usr_DUE").first<{ firebase_uid: string | null; purge_after: number | null }>();

  // Cleared so a re-run cannot try again, and so the row reads as finished.
  expect(row?.firebase_uid).toBeNull();
  expect(row?.purge_after).toBeNull();
});

it("leaves an identity whose window has not passed", async () => {
  await seedUser({
    id: "usr_EARLY", email: "deleted-usr_EARLY@agentdisk.invalid",
    firebaseUid: "fb-early", deletedAt: NOW, purgeAfter: NOW + 60_000
  });

  const result = await sweepPendingDeletions(env.DB, env.FILES, NOW, { dryRun: false });
  expect(result.identitiesDeleted).toBe(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run test/pending-deletions.test.ts -t "Firebase identity"`
Expected: FAIL — `identitiesDeleted` is undefined.

- [ ] **Step 3: Add the Admin API call**

In `apps/api/src/auth/firebase-admin.ts`, beside `setFirebaseUserDisabled`:

```ts
/**
 * Remove a Firebase identity outright.
 *
 * Disabling is the right move for a suspension and the wrong one for a
 * deletion: a disabled identity still owns its email address, so the person
 * can neither sign in nor sign up, and the address is unusable for good.
 *
 * A UID Firebase does not recognise counts as success. The sweep may retry
 * after a partial run, and "already gone" is the state we want.
 */
export async function deleteFirebaseUser(
  config: FirebaseAdminConfig | null,
  uid: string
): Promise<boolean> {
  if (config === null) return false;

  const token = await getAccessToken(config);
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${config.projectId}/accounts:delete`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ localId: uid }),
    }
  );

  if (response.ok) return true;
  if (response.status === 404) return true;

  const body = await response.text();
  if (body.includes("USER_NOT_FOUND")) return true;

  throw new Error(`Firebase identity delete failed (${response.status}): ${body}`);
}
```

- [ ] **Step 4: Sweep the queued identities**

In `apps/api/src/jobs/pending-deletions.ts`, add `identitiesDeleted: number` to `SweepResult`, and after the object sweep:

```ts
  // Identities, after the bytes. A failure here must not stop the objects
  // being erased - the bytes are the expensive half and the promise the
  // customer actually cares about.
  let identitiesDeleted = 0;
  const config = readFirebaseAdminConfig(env);

  const due = await db
    .prepare(
      `SELECT id, firebase_uid FROM users
        WHERE purge_after IS NOT NULL AND purge_after <= ?
          AND firebase_uid IS NOT NULL
        ORDER BY purge_after LIMIT ?`
    )
    .bind(force ? Number.MAX_SAFE_INTEGER : now, limit)
    .all<{ id: string; firebase_uid: string }>();

  for (const user of due.results ?? []) {
    if (dryRun) { identitiesDeleted += 1; continue; }
    try {
      await deleteFirebaseUser(config, user.firebase_uid);
      // Cleared together: the uid so a retry cannot repeat the call, and
      // purge_after so the row reads as finished rather than perpetually due.
      await db
        .prepare(`UPDATE users SET firebase_uid = NULL, purge_after = NULL WHERE id = ?`)
        .bind(user.id)
        .run();
      identitiesDeleted += 1;
    } catch (err) {
      console.log(JSON.stringify({
        level: "warn", message: "identity delete failed",
        userId: user.id, reason: err instanceof Error ? err.message : String(err),
      }));
    }
  }
```

`sweepPendingDeletions` must now take `env` to read the Firebase config. Add it as a parameter and update the two call sites in `src/index.ts`.

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/firebase-admin.ts apps/api/src/jobs/pending-deletions.ts \
        apps/api/src/index.ts apps/api/test/pending-deletions.test.ts
git commit -m "Delete the Firebase identity rather than disabling it"
```

---

### Task 4: Remove restore

The deferred-deletion design deleted restore; the code survived. It can now resurrect an account whose bytes a sweep has already erased, and report success.

**Files:**
- Modify: `apps/api/src/admin/users-access.ts` — delete `restoreUser`
- Modify: `apps/api/src/admin/access.ts` — delete `restoreWorkspace`
- Modify: `apps/api/src/routes/admin-console.ts` — delete both routes
- Modify: `apps/admin/src/screens/Users.jsx`, `Workspaces.jsx` — remove the controls
- Test: `apps/api/test/admin-console.test.ts`

**Interfaces:**
- Consumes: nothing. Removal only.
- Produces: `POST /v1/admin/users/:id/restore` and `.../workspaces/:id/restore` return **404**.

- [ ] **Step 1: Write the failing test**

```ts
it("has no restore route, because a restore cannot restore the bytes", async () => {
  // Pinned at 404 the way POST /v1/staff/users was: a route that answered
  // anything else would be describing a capability the product gave up.
  expect((await call("POST", "/v1/admin/users/usr_X/restore", admin, { reason })).status).toBe(404);
  expect((await call("POST", "/v1/admin/workspaces/ws_X/restore", admin, { reason })).status).toBe(404);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run test/admin-console.test.ts -t "no restore route"`
Expected: FAIL — receives 200 or 403, not 404.

- [ ] **Step 3: Delete the methods, the routes and the buttons**

Remove `restoreUser` from `users-access.ts`, `restoreWorkspace` from `access.ts`, both route branches from `admin-console.ts`, and the calling controls from the two console screens. Delete any test that asserted restore worked — it asserted a capability now deliberately gone.

- [ ] **Step 4: Run everything**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`, then `cd ../admin && npx vitest run && npm run build`
Expected: PASS, clean, builds.

- [ ] **Step 5: Commit**

```bash
git add -A apps/api/src/admin apps/api/src/routes/admin-console.ts apps/admin/src apps/api/test
git commit -m "Remove restore, which cannot restore the bytes"
```

---

### Task 5: Self-service account deletion

No self-service path exists. Deletion is staff-only, which means the only way for a customer to leave is to ask.

**Files:**
- Create: `apps/api/src/routes/account.ts`
- Modify: `apps/api/src/index.ts` — route `DELETE /v1/me`
- Modify: `apps/web/src/routes/Settings.jsx`, `apps/web/src/lib/api.js`
- Test: `apps/api/test/account-delete.test.ts`

**Interfaces:**
- Consumes: `deleteWorkspaceCascade(db, files, workspaceId, { defer: true })`; the email scrub and `purge_after` from Task 2; `MAX_CASCADE_WORKSPACES = 20`.
- Produces: `DELETE /v1/me`, body `{ confirmEmail: string }`, returning `{ workspacesDeleted, filesQueued, purgeAfter }`.

- [ ] **Step 1: Write the failing tests**

```ts
it("cancels the subscription, because the owner asked for it themselves", async () => {
  // Staff deletion still refuses while a subscription is live - a staff member
  // must not silently cancel somebody's paid plan. When the OWNER deletes
  // their own account they are that deliberate human, so the same act is
  // correct rather than forbidden. The asymmetry is the decision.
  await seedSubscription(ORG_ID, { status: "active" });

  const res = await call("DELETE", "/v1/me", ownerToken, { confirmEmail: OWNER_EMAIL });

  expect(res.status).toBe(200);
  expect(stripeStub.cancelled).toContain("sub_TEST");
  expect(stripeStub.detachedPaymentMethods.length).toBeGreaterThan(0);
});

it("refuses a confirmation that does not match", async () => {
  const res = await call("DELETE", "/v1/me", ownerToken, { confirmEmail: "wrong@example.com" });
  expect(res.status).toBe(400);
});

it("lets the same address sign up again afterwards", async () => {
  // The whole point of Tasks 2 and 3. Neither defect was caught by any test,
  // because nothing exercised the full round trip.
  await call("DELETE", "/v1/me", ownerToken, { confirmEmail: OWNER_EMAIL });

  const fresh = await mint("fb-uid-new", OWNER_EMAIL);
  const res = await call("GET", "/v1/whoami", fresh);

  expect(res.status).toBe(200);
  const body = await res.json() as { me: { workspace: { id: string } } };
  expect(body.me.workspace.id).not.toBe(WORKSPACE_A);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run test/account-delete.test.ts`
Expected: FAIL — 404, no such route.

- [ ] **Step 3: Write the route**

```ts
// apps/api/src/routes/account.ts
/**
 * A person closing their own account.
 *
 * Distinct from the staff path in exactly one respect, and deliberately: this
 * one cancels a live subscription. The rule that a human must never implicitly
 * cancel somebody's paid plan was written for staff acting on another person's
 * account. Here the account holder is doing it to their own, having typed
 * their address to confirm, so cancelling is what they asked for and refusing
 * would leave them paying for something they just destroyed.
 */
export async function deleteOwnAccount(ctx: AuthContext, request: Request): Promise<Response> {
  const self = ctx.self;
  if (self === null) {
    throw forbidden("An API key cannot delete an account. This is a person's act.");
  }

  const body = await readJson(request, z.object({ confirmEmail: z.string() }));
  const user = await findUserById(ctx.db.raw, self.userId);
  if (user === null || body.confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
    throw validationError("Type your email address exactly to confirm.");
  }

  const workspaces = await listOwnedWorkspaces(ctx.db.raw, self.userId);
  if (workspaces.length > MAX_CASCADE_WORKSPACES) {
    throw new ApiError("LIMIT_EXCEEDED",
      `This account owns ${workspaces.length} workspaces, more than the ${MAX_CASCADE_WORKSPACES} one request can destroy. Contact support.`);
  }

  // Billing first: a failure here must not leave an account destroyed and
  // still being charged. The reverse - cancelled but not deleted - is
  // recoverable by retrying.
  await cancelSubscriptionAndDetach(ctx, user.orgId);

  let filesQueued = 0;
  for (const ws of workspaces) {
    const result = await deleteWorkspaceCascade(ctx.db.raw, ctx.files, ws.id, { defer: true });
    filesQueued += result.filesQueued;
  }

  const purgeAfter = ctx.now + ACCOUNT_PURGE_TTL_MS;
  await ctx.db.raw
    .prepare(
      `UPDATE users
          SET deleted_at = ?, session_revoked_after = ?, updated_at = ?,
              email = ?, purge_after = ?
        WHERE id = ?`
    )
    .bind(ctx.now, ctx.now, ctx.now, `deleted-${self.userId}@agentdisk.invalid`, purgeAfter, self.userId)
    .run();

  return json({ workspacesDeleted: workspaces.length, filesQueued, purgeAfter });
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/account.ts apps/api/src/index.ts apps/api/test/account-delete.test.ts
git commit -m "Let a person close their own account"
```

---

### Task 6: The console Deletions screen

`job_runs` is written by the sweep and read by nothing. Staff cannot see the queue, the last run, or trigger one.

**Files:**
- Create: `apps/api/src/admin/deletions-access.ts`
- Modify: `apps/api/src/routes/admin-console.ts` — three routes
- Create: `apps/admin/src/screens/Deletions.jsx`
- Modify: `apps/admin/src/App.jsx`, `apps/admin/src/api.js`, `apps/admin/src/components/Shell.jsx`
- Test: `apps/api/test/admin-deletions.test.ts`

**Interfaces:**
- Consumes: `sweepPendingDeletions(db, files, now, env, options)` with `trigger: "admin"`, `actorId`, `actorEmail` — all already supported.
- Produces: `GET /v1/admin/deletions/queue`, `GET /v1/admin/deletions/runs`, `POST /v1/admin/deletions/run`.

- [ ] **Step 1: Write the failing test**

```ts
it("reports the queue, the runs, and runs one on demand", async () => {
  await seedPending({ id: "fil_Q", dueAt: NOW - 1000, sizeBytes: 500 });

  const queue = await (await call("GET", "/v1/admin/deletions/queue", admin)).json() as
    { files: number; bytes: number; overdue: number };
  expect(queue.files).toBe(1);
  expect(queue.bytes).toBe(500);
  expect(queue.overdue).toBe(1);

  const run = await call("POST", "/v1/admin/deletions/run", admin, { reason });
  expect(run.status).toBe(200);

  // Recorded with the staff actor, exactly as the cron's run is recorded
  // with none - an on-demand destruction must name who asked for it.
  const runs = await (await call("GET", "/v1/admin/deletions/runs", admin)).json() as
    { runs: { trigger: string; actor_email: string | null }[] };
  expect(runs.runs[0]?.trigger).toBe("admin");
  expect(runs.runs[0]?.actor_email).toBe(ADMIN_EMAIL);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run test/admin-deletions.test.ts`
Expected: FAIL — 404 on all three routes.

- [ ] **Step 3: Write the access class**

```ts
// apps/api/src/admin/deletions-access.ts
/**
 * The deletion queue and its history.
 *
 * Extends AuditedAdminAccess like every other area, so the run-now control
 * cannot be performed without the machinery that writes it down. That matters
 * more here than elsewhere: this button erases bytes on demand, ahead of the
 * window a customer was promised.
 */
export class AdminDeletionsAccess extends AuditedAdminAccess {
  async queue(): Promise<{ files: number; bytes: number; overdue: number; oldest: number | null }> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS files,
                COALESCE(SUM(size_bytes), 0) AS bytes,
                COALESCE(SUM(CASE WHEN purge_after <= ? THEN 1 ELSE 0 END), 0) AS overdue,
                MIN(marked_at) AS oldest
           FROM pending_deletions`
      )
      .bind(this.now)
      .first<{ files: number; bytes: number; overdue: number; oldest: number | null }>();
    return row ?? { files: 0, bytes: 0, overdue: 0, oldest: null };
  }

  async runs(limit = 20) {
    const rows = await this.db
      .prepare(`SELECT * FROM job_runs WHERE job = 'pending_deletions'
                 ORDER BY started_at DESC LIMIT ?`)
      .bind(limit)
      .all();
    return rows.results ?? [];
  }

  async runNow(files: R2Bucket, env: SweepEnv, reason: string) {
    await this.requireRole("admin", "run the deletion sweep");
    const result = await sweepPendingDeletions(this.db, files, this.now, env, {
      dryRun: !pendingDeletionEnabled(env),
      trigger: "admin",
      actorId: this.admin.id,
      actorEmail: this.admin.email,
    });
    await this.recordFleet({
      action: "deletions.run",
      targetType: "job_run",
      targetId: result.runId,
      reason,
      metadata: { objectsDeleted: result.objectsDeleted, dryRun: result.dryRun },
    });
    return result;
  }
}
```

- [ ] **Step 4: Add the routes and the screen**

Wire the three routes in `admin-console.ts` following the existing `area(...)` pattern. Build `Deletions.jsx` with three panels — **Queue** (files, bytes, overdue, oldest), **Last runs** (a table from `job_runs`: when, trigger, actor, dry-run, examined, deleted, freed, failed), and **Run now** (a `ConfirmModal` with `destructive={true}` and a required reason). Add it to the shell's navigation.

The run-now dialog must state plainly that it erases bytes ahead of the seven-day window a customer was promised.

- [ ] **Step 5: Run everything**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`, then `cd ../admin && npx vitest run && npm run build`
Expected: PASS, clean, builds.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/admin/deletions-access.ts apps/api/src/routes/admin-console.ts \
        apps/admin/src apps/api/test/admin-deletions.test.ts
git commit -m "Add the console Deletions screen"
```

---

### Task 7: Say what actually happens

The dialog promises files are "permanently removed". They are queued for seven days. `Legal.jsx` promises a purge "within roughly 30 days" and says nothing about invoice retention.

**Files:**
- Modify: `apps/web/src/routes/Settings.jsx` — the delete-workspace modal, and a new delete-account modal
- Modify: `apps/web/src/routes/Legal.jsx`
- Modify: `apps/web/src/routes/Settings.jsx` — the Privacy tab summary
- Test: `apps/web/test/settings.test.jsx`

**Interfaces:**
- Consumes: `DELETE /v1/me` from Task 5.
- Produces: no API surface.

- [ ] **Step 1: Write the failing test**

```jsx
it("tells you which parts go now and which go in seven days", async () => {
  render(<Settings />);
  await userEvent.click(screen.getByRole("button", { name: /delete workspace/i }));

  expect(screen.getByText(/API keys, agents, webhooks/i)).toBeInTheDocument();
  expect(screen.getByText(/in 7 days/i)).toBeInTheDocument();
  expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  expect(screen.getByText(/email support/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/settings.test.jsx -t "which parts go now"`
Expected: FAIL — the copy does not mention seven days.

- [ ] **Step 3: Rewrite the copy**

Replace the workspace dialog's alert with the two-part statement from the spec — what goes now and permanently, what goes in seven days, that there is no restore because tags are stripped at once, and that support can run it sooner on request. Add the account-deletion dialog with its billing and identity paragraphs, including that the address can be used to sign up again but nothing is recovered.

Update `Legal.jsx`: seven days, not thirty; and the invoice-retention sentence — *"We cancel your subscription and remove your payment details immediately. Invoices are retained for seven years as tax law requires; they contain your billing name, address and amounts, and nothing else about your account."* Update the Privacy tab to summarise it. `Legal.jsx` wins where they disagree.

- [ ] **Step 4: Run everything**

Run: `cd apps/web && npx vitest run && npm run build`
Expected: PASS, builds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/test
git commit -m "Say what deletion actually does"
```

---

## Self-Review

**Spec coverage.** D1 weekly + on-demand → Tasks 1, 6. D2 enable → Task 1. D3 email scrub → Task 2. D4 Firebase delete → Task 3. D5 remove restore → Task 4. D6 self-service cancels / staff refuses → Task 5. D7 detach + retain + disclose → Tasks 5, 7. D8 seven-day account window → Tasks 2, 3. Console section → Task 6. Re-join test → Task 5 Step 1. No gaps.

**Type consistency.** `ACCOUNT_PURGE_TTL_MS` defined in Task 2, used in Tasks 3 and 5. `purge_after` defined in Task 2's migration, read in Task 3, written in Task 5. `identitiesDeleted` added to `SweepResult` in Task 3, displayed in Task 6. `sweepPendingDeletions` gains `env` in Task 3; Task 6 calls the new signature.

**One thing to watch during execution:** Task 3 changes `sweepPendingDeletions`'s signature, and Task 6 depends on the new one. Execute in order, or Task 6's call will not compile.
