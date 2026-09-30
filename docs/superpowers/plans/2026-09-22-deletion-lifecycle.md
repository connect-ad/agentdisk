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

### Task 8: Make the claim link expire with the workspace, and answer 404

The token is valid for 30 days; the workspace it names is swept after 7. Between
day 8 and day 30 a valid link points at nothing. Separately, an already-claimed
link identifies itself, which on an unauthenticated route is an oracle.

**Files:**
- Modify: `apps/api/src/db/bootstrap.ts:37` — `CLAIM_TOKEN_TTL_MS`
- Modify: `apps/api/src/routes/claim.ts:165-167` — the already-claimed branch
- Modify: `apps/web/src/routes/Claim.jsx` — handle 404 in place of `ALREADY_CLAIMED`
- Test: `apps/api/test/claim.test.ts`

**Interfaces:**
- Consumes: `UNCLAIMED_TTL_MS` from `src/lib/claim.ts` (7 days, unchanged).
- Produces: `GET /v1/workspaces/claim/:token` returns **404** for claimed, expired and unknown tokens alike — one indistinguishable answer.

- [ ] **Step 1: Write the failing test**

```ts
it("answers a claimed link the same way it answers a token that never existed", async () => {
  // The point is indistinguishability. This route is unauthenticated, which
  // makes it the one place probing tokens is free, and "claimed" vs "never
  // existed" is exactly the bit a prober wants.
  const sandbox = await provision();
  await claimAs(OWNER_UID, sandbox.claimToken, { mode: "new" });

  const claimed = await SELF.fetch(`${URL_BASE}/v1/workspaces/claim/${sandbox.claimToken}`);
  const never = await SELF.fetch(`${URL_BASE}/v1/workspaces/claim/tok_doesnotexistatall`);

  expect(claimed.status).toBe(404);
  expect(never.status).toBe(404);
  expect(await claimed.text()).toBe(await never.text());
});

it("expires the link exactly when the workspace is swept", async () => {
  // A link outliving its subject is a link that lies. These are one number.
  expect(CLAIM_TOKEN_TTL_MS).toBe(UNCLAIMED_TTL_MS);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run test/claim.test.ts -t "never existed"`
Expected: FAIL — claimed returns 200 with `ALREADY_CLAIMED`, and the TTLs differ.

- [ ] **Step 3: Align the TTL**

```ts
// apps/api/src/db/bootstrap.ts
/**
 * A claim link lives exactly as long as the workspace it names.
 *
 * It was 30 days against a 7-day sweep, so for three weeks a valid token
 * pointed at something already deleted. The short window is the deliberate
 * half of the trade: an agent provisioning for somebody away for a week loses
 * the work. Accepted, because a link whose lifetime says nothing about whether
 * it still works is worse than a short one.
 */
export const CLAIM_TOKEN_TTL_MS = UNCLAIMED_TTL_MS;
```

- [ ] **Step 4: Return 404 for a claimed link**

Replace the `claimed_at !== null` branch in `routes/claim.ts` with `throw noSuchClaim();`, and replace the comment above it — the existing one argues for the behaviour being removed, so leaving it would document the opposite of the code:

```ts
  // A claimed link is answered exactly as an unknown one is. The previous
  // behaviour returned ALREADY_CLAIMED so that somebody re-opening their own
  // link got an explanation - but this route takes no credential, so that
  // explanation is equally available to anybody guessing tokens, and it
  // confirms which guesses named a real workspace. The auth chain has answered
  // every failure identically since the beginning; this route was the gap.
  //
  // What replaces the explanation is `claim_attempts`: support can say what
  // happened to a link, without the answer being free to everyone.
  if (workspace.claimed_at !== null) throw noSuchClaim();
```

Update `Claim.jsx` to render its existing not-found state on a 404 and drop the `ALREADY_CLAIMED` branch.

- [ ] **Step 5: Run everything**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`, then `cd ../web && npx vitest run && npm run build`
Expected: PASS, clean, builds.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/bootstrap.ts apps/api/src/routes/claim.ts apps/web/src apps/api/test/claim.test.ts
git commit -m "Expire a claim link with its workspace, and stop it identifying itself"
```

---

### Task 9: Record every claim attempt, and show it in the console

Task 8 removed the client's explanation. This is what replaces it, and the trail must outlive the workspace.

**Files:**
- Create: `apps/api/migrations/0020_claim_attempts.sql`
- Create: `apps/api/src/lib/claim-log.ts`
- Modify: `apps/api/src/routes/claim.ts` — log on every path
- Create: `apps/admin/src/screens/ClaimLinks.jsx`
- Modify: `apps/api/src/admin/deletions-access.ts`, `apps/api/src/routes/admin-console.ts`, `apps/admin/src/App.jsx`
- Test: `apps/api/test/claim-log.test.ts`

**Interfaces:**
- Consumes: `sha256Hex(token)` from `src/lib/claim.ts`.
- Produces: `recordClaimAttempt(db, entry, now): Promise<void>` where `entry` is `{ tokenHash, workspaceId?, outcome, userId?, ip?, userAgent? }`.
- Produces: `GET /v1/admin/claim-links?workspaceId=&tokenHash=`.

- [ ] **Step 1: Write the failing test**

```ts
it("records a refused attempt, and keeps it after the workspace is gone", async () => {
  const sandbox = await provision();
  await claimAs(OWNER_UID, sandbox.claimToken, { mode: "new" });

  // A second person hits the link. They are told nothing (Task 8) - this row
  // is the only place the fact survives.
  await SELF.fetch(`${URL_BASE}/v1/workspaces/claim/${sandbox.claimToken}`, {
    headers: { "cf-connecting-ip": "203.0.113.7" },
  });

  const rows = await env.DB.prepare(
    `SELECT outcome, ip, workspace_id FROM claim_attempts WHERE outcome = 'already_claimed'`
  ).all<{ outcome: string; ip: string; workspace_id: string }>();

  expect(rows.results?.length).toBe(1);
  expect(rows.results?.[0]?.ip).toBe("203.0.113.7");

  // No foreign key, so deleting the workspace must not take the evidence.
  await deleteWorkspaceCascade(env.DB, env.FILES, sandbox.workspaceId, { defer: true });
  const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM claim_attempts`)
    .first<{ n: number }>();
  expect(after?.n).toBe(rows.results?.length);
});

it("never stores the token itself", async () => {
  const sandbox = await provision();
  await SELF.fetch(`${URL_BASE}/v1/workspaces/claim/${sandbox.claimToken}`);

  const all = await env.DB.prepare(`SELECT token_hash FROM claim_attempts`).all<{ token_hash: string }>();
  for (const row of all.results ?? []) {
    expect(row.token_hash).not.toBe(sandbox.claimToken);
    expect(row.token_hash).toHaveLength(64);
  }
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run test/claim-log.test.ts`
Expected: FAIL — `no such table: claim_attempts`.

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/migrations/0020_claim_attempts.sql
-- Who touched which claim link, and what happened.
--
-- Task 8 made a claimed link answer 404, identical to a token that never
-- existed, because this route takes no credential and a distinguishable answer
-- tells a prober which guesses named a real workspace. That removed the
-- client's explanation. This is where the explanation goes instead: support can
-- say what happened to a link without the answer being free to everyone.
--
-- No foreign keys, deliberately, and for the same reason `pending_deletions`
-- has none: the workspace a row names may already be deleted, and the trail is
-- worth most precisely then. `workspace_id` is denormalised TEXT.
--
-- Only the HASH is stored. Same rule as `workspaces.claim_token_hash`: a
-- support engineer can confirm which link was used and can never use it.
CREATE TABLE claim_attempts (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL,
  workspace_id  TEXT,
  outcome       TEXT NOT NULL,
  user_id       TEXT,
  ip            TEXT,
  user_agent    TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_claim_attempts_token ON claim_attempts(token_hash, created_at DESC);
CREATE INDEX idx_claim_attempts_workspace ON claim_attempts(workspace_id, created_at DESC);
-- The retention sweep scans by age.
CREATE INDEX idx_claim_attempts_created ON claim_attempts(created_at);
```

- [ ] **Step 4: Write the recorder and call it everywhere**

```ts
// apps/api/src/lib/claim-log.ts
export type ClaimOutcome =
  | "previewed" | "claimed" | "already_claimed" | "expired" | "unknown_token";

/**
 * Never throws. A failure to write the log must not fail the claim - the
 * person's workspace matters more than our record of it, and a thrown error
 * here would turn a successful claim into a 500 after the work was done.
 */
export async function recordClaimAttempt(
  db: D1Database,
  entry: {
    tokenHash: string;
    workspaceId?: string | null;
    outcome: ClaimOutcome;
    userId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  },
  now: number
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO claim_attempts
           (id, token_hash, workspace_id, outcome, user_id, ip, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        newId("claimAttempt", now), entry.tokenHash, entry.workspaceId ?? null,
        entry.outcome, entry.userId ?? null, entry.ip ?? null,
        entry.userAgent?.slice(0, 256) ?? null, now
      )
      .run();
  } catch (err) {
    console.log(JSON.stringify({
      level: "warn", message: "claim attempt log failed",
      reason: err instanceof Error ? err.message : String(err),
    }));
  }
}
```

Call it from every exit of both claim handlers — preview success, claimed, expired, unknown token, and each refusal — passing `cf-connecting-ip` and `user-agent` from the request.

- [ ] **Step 5: Trim the log in the sweep**

These rows hold IP addresses of unauthenticated visitors — personal data, so they get a limit rather than living forever. In `jobs/pending-deletions.ts`, after the identity pass:

```ts
  // 90 days. Long enough for the investigation this table exists for, short
  // enough that a log of strangers' IP addresses does not become a liability
  // nobody decided to keep.
  if (!dryRun) {
    await db.prepare(`DELETE FROM claim_attempts WHERE created_at < ?`)
      .bind(now - CLAIM_ATTEMPT_RETENTION_MS)
      .run();
  }
```

Define `CLAIM_ATTEMPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000` in `src/lib/claim-log.ts` and import it.

- [ ] **Step 6: Add the route and the screen**

`GET /v1/admin/claim-links` on `AdminDeletionsAccess`, filtered by `workspaceId` or `tokenHash`. `ClaimLinks.jsx` shows one timeline per link: created by which agent, every preview with its IP, the claim and by whom, and every refusal since.

- [ ] **Step 7: Run everything**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`, then `cd ../admin && npx vitest run && npm run build`
Expected: PASS, clean, builds.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations apps/api/src apps/admin/src apps/api/test
git commit -m "Record every claim attempt, and show it in the console"
```

---

### Task 10: Sweep unclaimed sandboxes weekly, and give claim links a full console

The unclaimed sweep runs hourly and has `SANDBOX_EXPIRY_ENABLED = "false"` in both environments, so unclaimed sandboxes accumulate forever — the same defect as Task 1, in the other sweep. And Task 9's console screen shows attempts; this widens it to the links themselves.

**Files:**
- Modify: `apps/api/wrangler.toml` — `SANDBOX_EXPIRY_ENABLED` in `[env.dev]`
- Modify: `apps/api/src/index.ts` — the sandbox-expiry block in the scheduled handler
- Modify: `apps/api/src/admin/deletions-access.ts` — add `claimLinks()`
- Modify: `apps/api/src/routes/admin-console.ts` — extend `GET /v1/admin/claim-links`
- Modify: `apps/admin/src/screens/ClaimLinks.jsx`
- Test: `apps/api/test/sandbox-expiry.test.ts`, `apps/api/test/admin-claim-links.test.ts`

**Interfaces:**
- Consumes: `expireUnclaimedWorkspaces(db, files, now, ttlMs, options)` from `src/jobs/sandbox-expiry.ts`; `recordClaimAttempt` and the `claim_attempts` table from Task 9.
- Produces: `GET /v1/admin/claim-links?state=&q=` where `state` is one of `all | unclaimed | claimed | due` and `q` matches a workspace id, a claim id or a token hash.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/sandbox-expiry.test.ts
it("deletes an expired unclaimed sandbox once the flag is on", async () => {
  const sandbox = await provision({ createdAt: NOW - UNCLAIMED_TTL_MS - 1000 });

  const result = await expireUnclaimedWorkspaces(env.DB, env.FILES, NOW, UNCLAIMED_TTL_MS, {
    dryRun: false,
  });

  expect(result.deleted).toBe(1);
  const row = await env.DB.prepare(`SELECT id FROM workspaces WHERE id = ?`)
    .bind(sandbox.workspaceId).first();
  expect(row).toBeNull();
});

it("leaves a sandbox that has been claimed, however old", async () => {
  // claimed_at is the gate, not age. A claimed workspace is somebody's
  // property and the sweep must never reach it.
  const sandbox = await provision({ createdAt: NOW - UNCLAIMED_TTL_MS - 1000 });
  await env.DB.prepare(`UPDATE workspaces SET claimed_at = ? WHERE id = ?`)
    .bind(NOW, sandbox.workspaceId).run();

  const result = await expireUnclaimedWorkspaces(env.DB, env.FILES, NOW, UNCLAIMED_TTL_MS, {
    dryRun: false,
  });
  expect(result.deleted).toBe(0);
});
```

```ts
// apps/api/test/admin-claim-links.test.ts
it("lists links by state and finds one by id", async () => {
  const open = await provision();
  const taken = await provision();
  await claimAs(OWNER_UID, taken.claimToken, { mode: "new" });

  const unclaimed = await (await call("GET", "/v1/admin/claim-links?state=unclaimed", admin)).json() as
    { links: { workspaceId: string; state: string }[] };
  expect(unclaimed.links.map(l => l.workspaceId)).toContain(open.workspaceId);
  expect(unclaimed.links.map(l => l.workspaceId)).not.toContain(taken.workspaceId);

  const claimed = await (await call("GET", "/v1/admin/claim-links?state=claimed", admin)).json() as
    { links: { workspaceId: string; claimedByEmail: string | null }[] };
  const row = claimed.links.find(l => l.workspaceId === taken.workspaceId);
  expect(row?.claimedByEmail).toBe(OWNER_EMAIL);

  const found = await (await call("GET", `/v1/admin/claim-links?q=${open.workspaceId}`, admin)).json() as
    { links: unknown[] };
  expect(found.links).toHaveLength(1);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run test/sandbox-expiry.test.ts test/admin-claim-links.test.ts`
Expected: the expiry tests may pass already (the job is built); the console tests FAIL with 404.

- [ ] **Step 3: Enable the sandbox sweep**

In `apps/api/wrangler.toml`, set `SANDBOX_EXPIRY_ENABLED = "true"` in `[env.dev]` only — prod stays `"false"` for the same reason Task 1 leaves the other sweep off there.

Both sweeps now share the weekly cron set in Task 1; no separate schedule.

- [ ] **Step 4: Add the console query**

```ts
// apps/api/src/admin/deletions-access.ts
/**
 * Every claim link and where it stands.
 *
 * Deliberately one query over `workspaces` rather than over `claim_attempts`:
 * a link exists whether or not anybody has ever touched it, and the links
 * nobody has touched are the interesting ones when somebody asks why a person
 * never received theirs. The attempts are joined on for the timeline.
 *
 * `claim_token_hash` is returned, never a token - there is no token to return,
 * only its hash was ever stored.
 */
async claimLinks(state: "all" | "unclaimed" | "claimed" | "due", q: string | null, limit = 50) {
  const where: string[] = ["w.claim_token_hash IS NOT NULL"];
  if (state === "unclaimed") where.push("w.claimed_at IS NULL");
  if (state === "claimed") where.push("w.claimed_at IS NOT NULL");
  // "due" is the set the weekly sweep will take on its next run: unclaimed and
  // past its TTL. It is what somebody checks before clicking run-now.
  if (state === "due") where.push("w.claimed_at IS NULL AND w.created_at <= ?");

  const rows = await this.db
    .prepare(
      `SELECT w.id AS workspaceId, w.name, w.created_at AS createdAt,
              w.claimed_at AS claimedAt, w.claim_token_hash AS tokenHash,
              w.claim_token_expires_at AS expiresAt,
              w.storage_bytes_used AS storageBytes, w.file_count AS fileCount,
              u.email AS claimedByEmail,
              (SELECT COUNT(*) FROM claim_attempts a WHERE a.workspace_id = w.id) AS attempts
         FROM workspaces w
         LEFT JOIN memberships m ON m.workspace_id = w.id AND m.role = 'owner'
         LEFT JOIN users u ON u.id = m.user_id
        WHERE ${where.join(" AND ")}
          ${q ? "AND (w.id = ? OR w.claim_token_hash = ?)" : ""}
        ORDER BY w.created_at DESC LIMIT ?`
    )
    .bind(...[
      ...(state === "due" ? [this.now - UNCLAIMED_TTL_MS] : []),
      ...(q ? [q, q] : []),
      limit,
    ])
    .all();

  return rows.results ?? [];
}
```

- [ ] **Step 5: Extend the screen**

`ClaimLinks.jsx` gains a state filter — **All / Unclaimed / Claimed / Due for deletion** — and a search box matching a workspace id or a claim token hash. Each row shows the workspace, its size, when the link was created, when it expires, its state, who claimed it if anyone, and the attempt count. Selecting a row opens the Task 9 timeline.

The **Due for deletion** tab is the one that earns its keep: it is exactly what the next weekly sweep will destroy, which is what somebody checks before pressing run-now.

- [ ] **Step 6: Run everything**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`, then `cd ../admin && npx vitest run && npm run build`
Expected: PASS, clean, builds.

- [ ] **Step 7: Commit**

```bash
git add apps/api/wrangler.toml apps/api/src apps/admin/src apps/api/test
git commit -m "Sweep unclaimed sandboxes weekly, and list claim links in the console"
```

---

## Self-Review

**Spec coverage.** D1 weekly + on-demand → Tasks 1, 6. D2 enable → Task 1. D3 email scrub → Task 2. D4 Firebase delete → Task 3. D5 remove restore → Task 4. D6 self-service cancels / staff refuses → Task 5. D7 detach + retain + disclose → Tasks 5, 7. D8 seven-day account window → Tasks 2, 3. Console section → Task 6. Re-join test → Task 5 Step 1. No gaps.

**Type consistency.** `ACCOUNT_PURGE_TTL_MS` defined in Task 2, used in Tasks 3 and 5. `purge_after` defined in Task 2's migration, read in Task 3, written in Task 5. `identitiesDeleted` added to `SweepResult` in Task 3, displayed in Task 6. `sweepPendingDeletions` gains `env` in Task 3; Task 6 calls the new signature.

**One thing to watch during execution:** Task 3 changes `sweepPendingDeletions`'s
signature, and Tasks 6 and 9 depend on the new one. Execute in order, or their
calls will not compile.

**Both sweeps, not one.** Task 1 enables the pending-deletion sweep; Task 10
enables the unclaimed-sandbox sweep and puts both on the same weekly cron. They
are separate flags and separate jobs, and enabling only one leaves half the
product still never deleting anything.

**Claim coverage (Tasks 8, 9, 10):** TTL alignment and the 404 in Task 8; the
attempt log, its retention and the console screen in Task 9. Their order is not
cosmetic — Task 8 removes the explanation the client used to get, and Task 9 is
where that explanation goes instead. Shipping 8 alone leaves support unable to
answer a question the product previously answered by itself.
