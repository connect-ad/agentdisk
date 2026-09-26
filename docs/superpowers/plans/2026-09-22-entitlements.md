# Entitlements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce every declared plan limit, at the account, through one function — and make the billing lifecycle visible to the person paying for it.

**Architecture:** Ten limits are declared in `PlanLimits`; three are enforced. Storage and files already work through `assertQuotaAndWarn` against account-level counters (migrations 0017/0018). This extends that one function to the five count dimensions, moves the two period counters to the account, turns on the `past_due` block that cannot currently fire, records daily usage for charts, and builds the billing page and the seven customer emails.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), R2, Vitest with `@cloudflare/vitest-pool-workers`, React SPAs, Stripe SDK, Mailjet via `lib/email.ts`.

**Spec:** `docs/superpowers/specs/2026-09-22-entitlements-design.md`

## Global Constraints

- **Next migration number is `0021`.** `0019` and `0020` shipped with the deletion plan. `0017` is used twice — do not add a third.
- **Migrations are additive and run before the code deploy.** New code must never meet an old schema; old code must survive a new one.
- **One enforcement function.** No route performs its own `COUNT(*)` against a limit. The `backlog/017` failure was a warning that lived only in the dashboard's arithmetic and lied; this plan must not recreate it in five places.
- **Over-limit blocks the next create and never breaks what exists** (D5). Reads, downloads and deletes always work — the way out must not be blocked by the block.
- **Every billable number is account-scoped** (D4). A workspace carries descriptive counters for display only.
- **The type is the guard.** `assertWithinQuota` takes `WorkspaceRow & AccountUsage`; extend that discipline rather than passing loose numbers.
- **Countable overages are permanent** (R4). Nothing converges `agents`, `apiKeys`, `members` or `workspaces` — they cost nothing to hold, and forcing an account under would break running agents to save nothing.
- **Dormancy requires `stripe_subscription_id IS NULL`.** A paying account is never dormant-deleted, whatever its usage. Lowering a plan's limits must never make a customer deletable.
- **Dunning email is Stripe's job.** Ours say what happens *to the product* — what is locked, what is queued, when it goes.
- **Test commands:** `cd apps/api && npx vitest run` and `npx tsc --noEmit`; `cd apps/web && npx vitest run && npm run build`; `cd apps/admin && npx vitest run && npm run build`.

---

### Task 1: Put real numbers in the plan table

Data only. Deliberately first: shipping enforcement against today's `UNLIMITED` values is a no-op that looks finished.

**Files:**
- Modify: `apps/api/src/lib/plans.ts` — `PLAN_LIMITS`
- Modify: `apps/api/migrations/0012_plan_catalogue.sql` is **not** touched; add `apps/api/migrations/0021_plan_values.sql`
- Test: `apps/api/test/quota.test.ts`

**Interfaces:**
- Consumes: `PlanLimits` (unchanged shape).
- Produces: the values every later task enforces.

- [ ] **Step 1: Write the failing test**

```ts
it("sells a file count, not an unlimited one", () => {
  // The actual cost hole. maxFileBytes bounds one request; nothing bounded
  // the number of requests, so a million 10 KB files cost $4.50 to ingest and
  // paid nothing on Free.
  for (const plan of PLAN_NAMES) {
    expect(PLAN_LIMITS[plan].fileCount).toBeLessThan(UNLIMITED);
  }
});

it("gives every plan ten times its storage as egress", () => {
  for (const plan of PLAN_NAMES) {
    expect(PLAN_LIMITS[plan].egressBytesPerPeriod).toBe(PLAN_LIMITS[plan].storageBytes * 10);
  }
});

it("never sells a file size the upload path cannot carry", () => {
  // R2's single-part ceiling is 4.995 GiB and multipart is not built.
  for (const plan of PLAN_NAMES) {
    expect(PLAN_LIMITS[plan].maxFileBytes).toBeLessThanOrEqual(4.9 * GB);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run test/quota.test.ts -t "file count"`
Expected: FAIL — `fileCount` is `UNLIMITED` on every plan.

- [ ] **Step 3: Apply the table**

```ts
free:  { storageBytes: 1*GB,   egressBytesPerPeriod: 10*GB,  fileCount: 10_000,     maxFileBytes: 100*MB, agents: 1,  apiKeys: 2,   members: 1,  workspaces: 1,  shareLinks: 0 },
basic: { storageBytes: 5*GB,   egressBytesPerPeriod: 50*GB,  fileCount: 100_000,    maxFileBytes: 500*MB, agents: 5,  apiKeys: 6,   members: 2,  workspaces: 3,  shareLinks: 10 },
pro:   { storageBytes: 50*GB,  egressBytesPerPeriod: 500*GB, fileCount: 1_000_000,  maxFileBytes: 1*GB,   agents: 10, apiKeys: 20,  members: 5,  workspaces: 10, shareLinks: 100 },
team:  { storageBytes: 500*GB, egressBytesPerPeriod: 5*TB,   fileCount: 10_000_000, maxFileBytes: 4.9*GB, agents: 50, apiKeys: 100, members: 25, workspaces: 50, shareLinks: UNLIMITED },
```

`requestsPerPeriod` stays `UNLIMITED` on every plan (D3: counted, never capped).

Migration `0021_plan_values.sql` updates the `plans` rows to match, so the catalogue and the floor agree.

- [ ] **Step 4: Run the suite**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: PASS. Tests asserting `UNLIMITED` egress are asserting the decision this reverses — update them and say so.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/plans.ts apps/api/migrations/0021_plan_values.sql apps/api/test/quota.test.ts
git commit -m "Put real numbers in the plan table"
```

---

### Task 2: Enforce the five count dimensions

`agents`, `apiKeys`, `members`, `workspaces` and `shareLinks` are declared and checked nowhere. `QuotaDimension` already names two of them.

**Files:**
- Modify: `apps/api/src/lib/quota.ts` — extend `QuotaDemand` and `assertWithinQuota`
- Create: `apps/api/src/lib/entitlement.ts` — the counting helper
- Modify: `apps/api/src/routes/agents.ts`, `keys.ts`, `members.ts`, `workspaces.ts`, `shares.ts`
- Test: `apps/api/test/entitlements.test.ts`

**Interfaces:**
- Produces: `assertEntitlement(ctx, demand): Promise<void>` where `demand` extends today's `QuotaDemand` with `agents?`, `apiKeys?`, `members?`, `workspaces?`, `shareLinks?`.
- Produces: `countForAccount(db, orgId, dimension): Promise<number>`.

- [ ] **Step 1: Write the failing test**

```ts
it("refuses the agent that would exceed the plan, and names the dimension", async () => {
  await setPlan(ORG_ID, "free");            // agents: 1
  await seedAgent({ workspaceId: WORKSPACE_A, id: "agt_ONE" });

  const res = await call("POST", "/v1/agents", token, { name: "second" });
  expect(res.status).toBe(429);
  const body = await res.json() as { error: { details: { limit: string } } };
  expect(body.error.details.limit).toBe("agents");
});

it("counts across the whole account, not one workspace", async () => {
  // The property the storage fix established, extended to the rest. Two
  // workspaces on one bill share one allowance.
  await setPlan(ORG_ID, "free");
  await seedAgent({ workspaceId: WORKSPACE_B, id: "agt_ELSEWHERE" });

  const res = await call("POST", "/v1/agents", token, { name: "second" });
  expect(res.status).toBe(429);
});

it("lets an over-limit account delete, so there is a way out", async () => {
  // D5. The block must never block the thing that clears it.
  await setPlan(ORG_ID, "free");
  await seedAgent({ workspaceId: WORKSPACE_A, id: "agt_ONE" });
  await seedAgent({ workspaceId: WORKSPACE_A, id: "agt_TWO" });

  expect((await call("DELETE", "/v1/agents/agt_TWO", token)).status).toBe(200);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run test/entitlements.test.ts`
Expected: FAIL — creation succeeds; nothing counts.

- [ ] **Step 3: Write the counting helper**

```ts
// apps/api/src/lib/entitlement.ts
/**
 * The five count dimensions do NOT get denormalised counters.
 *
 * They change rarely - an account creates an agent occasionally, not per
 * request - and they are bounded by the limit being checked, so the count is
 * small by construction. A denormalised counter for a number that moves twice
 * a month is drift waiting to happen, and the reconciler would be doing more
 * work than the COUNT.
 *
 * Storage and files are the opposite on both counts, which is why they have
 * counters and these do not.
 */
export async function countForAccount(
  db: D1Database,
  orgId: string,
  dimension: "agents" | "apiKeys" | "members" | "workspaces" | "shareLinks"
): Promise<number> {
  const sql = {
    agents: `SELECT COUNT(*) AS n FROM agents a JOIN workspaces w ON w.id = a.workspace_id
              WHERE w.org_id = ? AND a.status != 'deleted'`,
    apiKeys: `SELECT COUNT(*) AS n FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id
               WHERE w.org_id = ? AND k.revoked_at IS NULL`,
    members: `SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?`,
    workspaces: `SELECT COUNT(*) AS n FROM workspaces WHERE org_id = ? AND status != 'deleted'`,
    shareLinks: `SELECT COUNT(*) AS n FROM share_links s JOIN workspaces w ON w.id = s.workspace_id
                  WHERE w.org_id = ?`,
  }[dimension];

  const row = await db.prepare(sql).bind(orgId).first<{ n: number }>();
  return row?.n ?? 0;
}
```

- [ ] **Step 4: Extend the demand and call it from every creation route**

Each route declares what it is about to create and calls `assertEntitlement` before writing. No route counts rows itself.

- [ ] **Step 5: Run everything**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "Enforce the five count dimensions at the account"
```

---

### Task 3: Move egress and requests to the account, and start counting requests

`requests_period` is never incremented — permanently zero, and reported by `whoami` as a fact.

**Files:**
- Create: `apps/api/migrations/0022_account_period_counters.sql`
- Modify: `apps/api/src/db/workspace-scoped.ts` — `WorkspaceScopedCounters`
- Modify: `apps/api/src/middleware/auth.ts` — increment requests
- Modify: `apps/api/src/lib/quota.ts`, `apps/api/src/routes/whoami.ts`
- Test: `apps/api/test/quota.test.ts`, `apps/api/test/auth.test.ts`

**Interfaces:**
- Produces: `organizations.egress_bytes_period`, `.requests_period`, `.period_reset_at`.
- Removes: the same three columns from `workspaces`.

- [ ] **Step 1: Write the failing test**

```ts
it("counts a request, so the number stops being a lie", async () => {
  // `whoami` has reported `requests: 0 used` since the beginning, because
  // nothing ever incremented the counter it reads.
  const before = await orgRequests(ORG_ID);
  await call("GET", "/v1/whoami", token);
  expect(await orgRequests(ORG_ID)).toBeGreaterThan(before);
});

it("spends one egress allowance across every workspace", async () => {
  await setPlan(ORG_ID, "free");            // egress: 10 GB
  await setOrgEgress(ORG_ID, 10 * GB - 10);
  await expect(download(WORKSPACE_B, "big.bin")).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run test/auth.test.ts -t "counts a request"`
Expected: FAIL — no such column, and nothing increments.

- [ ] **Step 3: Migration and counter move**

Columns move to `organizations`, backfilled by summing the workspace rows. The workspace columns are dropped.

- [ ] **Step 4: Increment requests off the response path**

In `withAuth`, via `waitUntil` — the same treatment `last_used_at` gets, and for the same reason: a D1 write must not be in the caller's latency.

- [ ] **Step 5: Run everything**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations apps/api/src apps/api/test
git commit -m "Move the period counters to the account, and count requests"
```

---

### Task 4: Make `past_due` fire

`assertBillingAllowsWrite` is only reached when `requirement.demand` declares bytes or files, and no route declares `demand`. The billing status is always read as `"active"`.

**Files:**
- Modify: every write route — declare `demand` in its `Requirement`
- Modify: `apps/api/src/middleware/auth.ts`
- Test: `apps/api/test/billing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("blocks a write on an unpaid account, and allows every read", async () => {
  await setBillingStatus(ORG_ID, "past_due");

  await expect(upload(WORKSPACE_A, "new.txt")).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  // Reads, downloads and deletes continue. Locking somebody out of their own
  // files to chase a payment turns a billing problem into a support crisis.
  expect((await call("GET", "/v1/files", token)).status).toBe(200);
  expect((await call("DELETE", `/v1/files/${FILE_ID}`, token)).status).toBe(200);
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — the upload succeeds.

- [ ] **Step 3: Declare `demand` on the write routes, and commit**

```bash
git commit -m "Let past_due actually block a write"
```

---

### Task 5: Usage history and the dashboard charts

**Files:**
- Create: `apps/api/migrations/0023_usage_daily.sql`
- Create: `apps/api/src/jobs/usage-snapshot.ts`
- Modify: `apps/api/src/index.ts`, `apps/api/src/routes/whoami.ts`
- Modify: `apps/web/src/routes/Usage.jsx`
- Test: `apps/api/test/usage-snapshot.test.ts`

Replaces the four meters — which render a bar against `UNLIMITED` and sit at 0% forever — and fills the `"Daily usage charts are not built yet"` placeholder. 30-day retention, trimmed by the same sweep.

- [ ] **Step 1–6:** snapshot table, daily job, retention, endpoint, charts, commit.

---

### Task 6: The billing page

`getBilling` returns three things: plan id, billing status, purchasable plan ids. No invoices, no prices, no package contents.

**Files:**
- Modify: `apps/api/src/routes/billing.ts` — invoices, plan detail
- Modify: `apps/web/src/routes/SettingsTabs.jsx` — `BillingTab`
- Test: `apps/api/test/billing.test.ts`

Current package with its limits, the last invoices from Stripe, the plans available, and a **cancel** control that deep-links into Stripe's portal. No card form and no plan-change UI: `Billing.jsx` already draws that line, and a plan-change screen here would be a second place for pricing to drift out of step with Stripe.

- [ ] **Step 1–6:** endpoint, invoices, UI, cancel deep-link, tests, commit.

---

### Task 7: The seven emails

The product sends two: a password reset and a test.

**Files:**
- Modify: `apps/api/src/lib/email.ts`
- Modify: `apps/api/src/routes/stripe-webhook.ts` — handle `invoice.upcoming`
- Create: `apps/api/src/jobs/quota-warnings.ts`
- Test: `apps/api/test/emails.test.ts`

| Trigger | To |
|---|---|
| `invoice.upcoming` (Stripe fires ~7 days ahead) | owner |
| `invoice.payment_failed` | owner |
| 80% / 95% of storage or files | owner, once per threshold per period |
| Workspace deleted | owner **and every member of that workspace** |
| Account deleted | owner |
| Bytes erased by the sweep | owner |

Dedupe state is `organizations.warned_80_at` / `warned_95_at`, cleared when usage drops back below or the period resets.

**The recipient rule matters most for workspace deletion** — a reader whose workspace vanishes currently finds out by it being gone.

- [ ] **Step 1–6:** templates, triggers, dedupe, recipients, tests, commit.

---

### Task 8: Dormancy, and the staff extension

**Files:**
- Create: `apps/api/migrations/0024_dormancy.sql` — `users.last_seen_at`, `organizations.deletion_deferred_until`
- Modify: `apps/api/src/auth/authenticate.ts` — throttled `last_seen_at` write
- Create: `apps/api/src/jobs/dormancy.ts`
- Modify: `apps/admin/src/screens/Users.jsx` — the extension control
- Test: `apps/api/test/dormancy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("never deletes an account that is paying, however far over its limit", async () => {
  // Lowering a plan's limits in the console makes every account on it
  // over-limit. A paying customer deleted on a timer because somebody edited a
  // pricing row is the failure this guard exists for.
  await setSubscription(ORG_ID, "sub_LIVE");
  await setOrgStorage(ORG_ID, 500 * GB);
  await setLastSeen(ORG_ID, NOW - 400 * DAY);

  const result = await sweepDormant(env.DB, NOW, { dryRun: false });
  expect(result.deleted).toBe(0);
});

it("respects a staff extension", async () => {
  await setSubscription(ORG_ID, null);
  await setOrgStorage(ORG_ID, 5 * GB);          // over Free
  await setLastSeen(ORG_ID, NOW - 400 * DAY);
  await setDeferredUntil(ORG_ID, NOW + 14 * DAY);

  expect((await sweepDormant(env.DB, NOW, { dryRun: false })).deleted).toBe(0);
});
```

- [ ] **Step 2–6:** activity column, throttled write, sweep, extension control, tests, commit.

---

### Task 9: Activity analytics in the console

Active in 7 / 30 / 90 days, never-returned-after-signup, dormant-and-over-limit, and accounts nearing their deletion date — the same query the sweep runs, so you can see who is about to go and extend them before it happens.

**Files:**
- Modify: `apps/api/src/admin/users-access.ts`, `apps/api/src/routes/admin-console.ts`
- Create: `apps/admin/src/screens/Activity.jsx`

- [ ] **Step 1–5:** queries, route, screen, tests, commit.

---

### Task 10: Removals and the deploy guard

| Removed | Why |
|---|---|
| `workspaces.egress_bytes_period`, `.requests_period`, `.period_reset_at` | Moved to `organizations` in Task 3 |
| `QuotaDimension` members nothing throws | After Task 2 every member is reachable; any that is not goes |
| The dashboard's client-only `shareLinks` gate | Replaced by server enforcement |

Plus the config assertion (R6): **if any purchasable plan's `maxFileBytes` exceeds 100 MB, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` must be set.** A deployment that cannot honour what it sells fails the pipeline rather than becoming a support thread.

- [ ] **Step 1–4:** assertion, removals, full suite, commit.

---

## Self-Review

**Spec coverage.** D1 egress 10× → Task 1. D2 fileCount → Task 1. D3 requests counted → Task 3. D4 account scope → Tasks 2, 3. D5 block-not-break → Task 2. D6 one function → Task 2. D7 4.9 GB → Tasks 1, 10. D9 read-only over limit → Tasks 2, 4. R3 dormancy 30 days → Task 8. R4 permanent overage → constraint, no task needed. R5 warnings → Task 7. R6 deploy guard → Task 10. R8 claim at limit → **gap, see below.** Billing page → Task 6. Emails → Task 7. Activity analytics → Task 9.

**One gap found, and deliberately left:** R8 (a claim refused when it would exceed a limit, showing the shortfall and the sweep deadline) has no task. It belongs in Task 2 — the claim route is a creation path like any other — but the *prevention* half needs the claim page to know the claimer's usage before they choose, which is dashboard work sitting in neither plan. Added as a note on Task 2 rather than a silent omission.

**Ordering.** Task 1 must precede Task 2: enforcement against `UNLIMITED` values is a no-op that looks finished. Task 3 must precede Task 5, which charts what Task 3 starts recording. Task 8 must precede Task 9, which reads the column Task 8 adds.
