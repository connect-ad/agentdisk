# AgentDisk — Production Readiness Audit

**Date:** 19 September 2026 · **Branch:** `dev` @ `4bf37fb` · **Repo:** `connect-ad/agentdisk` (**public**)
**Method:** Five parallel audits (API, dashboard, staff console, infrastructure, documentation), each reading source in full and tracing every frontend call to the handler that serves it. All builds and test suites were executed. Every P0 in this report was independently re-verified by the coordinating session against the file and line cited.

**Working tree note:** 7 files carry uncommitted changes. Citations are against the **working tree as read**, and where HEAD differs it is called out explicitly — that difference is itself finding **B-01**.

---

## Executive Summary

### Overall state

The engineering core is strong and largely matches its documentation. Tenant isolation, the authorization chain, the audit discipline, the scope model, the Terraform layer and the dev pipeline are genuinely well built — the audit verified dozens of claimed invariants individually and found them enforced in code, not merely asserted in comments.

The production gap is **not architectural**. It is three things:

1. **A set of UI controls that report success for work that never happened**, plus one that silently destroys user data.
2. **Enforcement that was designed, built, and then left unreachable** — the billing write-block, four of eight plan limits, and all rate limiting.
3. **Operational configuration and two stale branches** — `main` predates the entire application and carries an ungated production-deploy trigger.

### Verified build and test baseline

| Target | Result |
|---|---|
| `apps/api` | **674 tests / 37 files — all pass**; `tsc --noEmit` clean |
| `apps/web` | **195 tests / 16 files — all pass**; build clean |
| `apps/admin` | **33 tests / 3 files — all pass**; build clean |

Tests passing is **not** evidence of correctness for anything below. Several P0s sit in code paths no test exercises, and each says so.

### The twelve production blockers

| # | Blocker | Area |
|---|---|---|
| **B-01** | A cross-scope data-leak fix exists only in the uncommitted working tree; the branch tip still ships the leak | API |
| **B-02** | `past_due` / `canceled` write block is dead code on the entire REST and MCP surface | API |
| **B-03** | MCP `move_file` and `copy_file` have never worked — wrong body field name | API |
| **B-04** | Sandbox discards the one-time claim URL → workspace permanently unclaimable, deleted after 7 days | Dashboard |
| **B-05** | File Caption/Tags fields promise *"Saved when you click away"* and save nothing | Dashboard |
| **B-06** | Fabricated webhook delivery failures rendered as live operational telemetry | Dashboard |
| **B-07** | Staff console ships with **zero** security headers on the cross-tenant origin | Console / Infra |
| **B-08** | "Pull everything" overwrites the whole pricing catalogue on one click, no confirmation | Console |
| **B-09** | That same catalogue overwrite writes **no audit record** | Console |
| **B-10** | `main` carries an ungated `Deploy prod` workflow naming a GitHub Environment that does not exist | Infra |
| **B-11** | `main` is 191 commits behind `dev`; first prod release is a whole-application merge firing four pipelines at once | Infra |
| **B-12** | The entire `docs/design/` specification package (23 files, 4,493 lines) was deleted from the repo and nothing records it | Docs |

### Major missing functionality

- **The product cannot be purchased through its own UI.** `POST /v1/billing/checkout-session` is fully implemented and tested (12 tests); no frontend file references it or `getBilling`'s `purchasable` array.
- **No rate limiting on any authenticated route or on MCP.** `lib/rate-limit.ts` has exactly one call site — the anonymous sandbox.
- **Four of eight declared plan limits** (`agents`, `apiKeys`, `members`, `workspaces`) have zero enforcement call sites.
- **No React error boundary** anywhere in the dashboard, despite ten built error pages.
- **No alerting, no error reporting, no log retention declared.**

### Major unnecessary functionality

- `POST /v1/staff/users` — a routed 501 whose body instructs an impossible action against columns dropped by migration 0014, using the one staff role-gate that writes no audit row on denial.
- Four orphaned staff API methods with no UI: agent disable, single-key revoke, transfer-ownership, blast-radius.
- `AccentPicker`, the Agents row-action column, four dead admin exports, `react-router-dom` (unused).

---

## Application Map

### `apps/api` — Cloudflare Worker (REST + MCP, one deployable)

Hand-written structural segment routing in `src/index.ts` (880 lines) plus `src/routes/staff-router.ts` (36 staff routes). **No 405 anywhere** — a known route with the wrong method returns 404.

**11 routes bypass `withAuth`.** All were checked against the "one identical auth-failure body" invariant; all pass except `POST /v1/webhooks/stripe`, which returns two distinguishable 401 bodies (P3). The `backlog/029` 404-on-missing-credential bug at `GET /v1/workspaces` is **fixed** (`src/index.ts:322`).

Surfaces: files (both upload paths, move, copy, soft delete, restore), folders, search, agents, keys, members, webhooks, activity, billing, workspaces, claim, staff (36), MCP (10 tools), 4 cron jobs.

### `apps/web` — dashboard SPA (`app-dev.agentdisk.io`)

| Group | Routes |
|---|---|
| Marketing / public | `/`, `/pricing`, `/docs`, `/terms`, `/privacy` |
| Auth | `/login`, `/signup`, `/verify-email`, `/forgot-password`, `/reset-password` |
| Workspace | `/w/:ws` + `/files`, `/agents`, `/agents/:id`, `/keys`, `/mcp`, `/webhooks`, `/activity`, `/usage`, `/settings`, `/billing`, `/profile`, `/support` |
| Public by design | `/claim/:token`, `/sandbox` |
| Error pages | `/301` `/304` `/400` `/401` `/403` `/410` `/429` `/500` `/maintenance`, `*` |

**Orphans:** `/sandbox` (zero inbound links — the product's stated differentiator has no entry point), `/dashboard`, `/403`, `AccentPicker`.
**Unguarded:** `/account/profile` sits outside `RequireAuth`.

### `apps/admin` — staff console (`admin-dev.agentdisk.io`)

Nine screens, one shell, History API routing, no router library. Separate origin by design. **Nothing orphaned or unreachable.** All 40 `api.js` methods resolve to live backend routes — the gaps run the other way (four backend capabilities with no UI).

Auth is **Firebase ID token + a `staff_users` row** — there is no staff cookie, no password, no TOTP. CLAUDE.md's description of this is stale (see Documentation Mismatch).

---

## Production Blockers — detail

### B-01 · Cross-scope listing leak fixed only in the working tree · **P0**

**Location:** `apps/api/src/db/workspace-scoped.ts` (4 call sites), reached from `src/routes/files.ts:537` and `src/routes/folders.ts:150`.

At `HEAD`, the collection queries used `path LIKE 'prefix%'` where `prefix` is `effectiveListPrefix(ctx.scope.pathPrefix, requested)` — **the API key's own scope**. A key scoped `/agents/bot` therefore **listed and searched** `/agents/bot-evil/secrets.txt`. This is the exact violation CLAUDE.md's whole-segment rule forbids: `scopeAllowsPath` enforces the boundary one row at a time while the bulk queries contradicted it.

The working tree adds `prefixBinds()` (segment-anchored `path = ? OR path LIKE ?/%`) at all four sites plus **six regression tests** in `test/files.test.ts`. The fix is complete — the cascade queries at `:423` and `:447` were already anchored, and the three remaining `LIKE ?` uses elsewhere are search filters and slug checks, not boundaries.

**Action:** Commit this. Until it lands, the branch tip ships the leak.

---

### B-02 · `past_due` write block is dead code · **P0**

**Location:** `apps/api/src/lib/quota.ts:84`, `src/middleware/auth.ts:361`, `:284-291`.

```ts
// quota.ts:84 — fifth parameter, defaulted
export function assertWithinQuota(workspace, limits, demand, now, billingStatus = "active")

// middleware/auth.ts:361 — four arguments passed
assertWithinQuota(ctx.workspace, ctx.limits, demand, ctx.now);
```

`assertQuotaAndWarn` is the only function every write path calls, and it omits the argument. The middleware's own real-status call is gated on `intendsWrite`, computed from `requirement.demand` — and **no route or MCP tool declares `demand`** (verified by grep; `auth.ts:97-100` says so in a comment). So `assertBillingAllowsWrite` returns immediately at `quota.ts:63`.

A customer whose card has failed uploads without limit while `getBilling` tells them `writesBlocked: true`. The `invoice.payment_failed` webhook correctly writes `past_due`; nothing reads it for enforcement. The only place the block fires is the claim merge (`routes/claim.ts:551`), which passes it explicitly.

**Action:** Make `billingStatus` **required** so the compiler finds every caller. Resolve org status once in `withAuth` onto `AuthContext`. Add a test asserting `POST /v1/files` returns `LIMIT_EXCEEDED` with `details.limit === "billing"` for a `past_due` org — no such test exists.

---

### B-03 · MCP `move_file` and `copy_file` are 100% broken · **P0**

**Location:** `apps/api/src/mcp/tools.ts:271` and `:293` vs `src/routes/folders.ts:227,233` and `:268,278`.

```ts
jsonRequest("POST", `/v1/files/${id}/move`, { newPath: args.newPath })  // tools.ts:271
const body = raw as { path?: unknown };                                 // folders.ts:227
```

Every call returns `VALIDATION_ERROR: path is required.` regardless of arguments. **20% of the advertised MCP surface has never worked**, and it is a direct counter-example to the "two surfaces cannot drift" claim made in CLAUDE.md and in `tools.ts:252-259` itself.

No test catches it: `test/mcp.test.ts` mentions `move_file` only in two `tools/list` scope assertions, never a `tools/call`.

**Action:** Map the argument (`{ path: args.newPath }`). Then add a `tools/call` round-trip test that **iterates `TOOLS`** rather than naming tools by hand, so a new tool cannot ship untested. Consider making `viaHandler` assert a 2xx so a silent 400 cannot masquerade as a result.

---

### B-04 · Sandbox discards the claim URL · **P0 — silent data loss**

**Location:** `apps/web/src/routes/Sandbox.jsx:149-187` (`grep claim` returns **nothing**) vs `apps/api/src/routes/create-workspace.ts:148-150`.

The API returns `claim: { url, expiresAt }` and a `notice` reading *"The claim URL is shown once too: it is how a person takes ownership of this workspace, and an unclaimed workspace is eventually deleted."* The screen renders workspace id, agent name, API key and a curl snippet, and throws the claim object away.

Only the **SHA-256** of the token is stored (`create-workspace.ts:143-155`), so the link **cannot be reissued by anyone, support included**. Every sandbox workspace created through the dashboard is permanently unclaimable and is swept after 7 days — with the user's files.

**Action:** Render `result.claim.url` with the same reveal-once treatment as the key, plus `expiresAt`. One JSX block.

---

### B-05 · File Caption and Tags fake a save · **P0**

**Location:** `apps/web/src/routes/FileBrowser.jsx:524-525`.

```jsx
<Input label="Caption" placeholder="Add a caption…" />
<Input label="Tags" placeholder="Add tags…" hint="Comma-separated. Saved when you click away." />
```

No `value`, no `onChange`, no blur handler, no API call. The promise is **in the field's own hint**. Existing values are invisible too: `toRow` (`:55-68`) drops `caption` and `tags` from the response. The backend fully supports both (`routes/files.ts:87-89,269,279-280`; returned by `toFileResource` at `:182-184`).

**Action:** Wire to `PATCH /v1/files/:id`, or remove both fields **and the hint**. Do not ship the hint as written.

---

### B-06 · Fabricated webhook delivery failures · **P0**

**Location:** `apps/web/src/routes/Webhooks.jsx:23-30`, rendered `:223`.

A hardcoded string of three invented responses (`503 upstream connect error`, `502 Bad Gateway`, `503`) is printed under the heading **"Recent delivery failures"** for the endpoint the user is inspecting. Nothing in the product records delivery attempts — the webhook resource has no delivery fields (`routes/webhooks.ts:67-82`).

This is mock data presented as operational telemetry on the screen an engineer opens to debug a live integration.

**Action:** Delete the constant and the panel; replace with "Delivery history is not recorded yet." (the staff console already words it this way).

---

### B-07 · Staff console has no security headers · **P0**

**Location:** `apps/admin/vite.config.js` (7 lines, no plugin); no `_headers` file exists anywhere under `apps/admin`.

```js
export default defineConfig({ plugins: [react()], build: { outDir: 'dist', sourcemap: true } });
```

`apps/web` generates CSP, HSTS, X-Frame-Options, X-Content-Type-Options and Referrer-Policy at build time via `renderHeadersFile` (`apps/web/vite.config.js:6`). The console — **the single origin with cross-tenant reach over every customer's data** — has none of them. It is framable, so a "Delete workspace" or "Pull everything" confirmation is clickjackable.

`apps/admin/scripts/smoke-test.mjs` makes **no header assertion** (the web one has 23), so nothing would ever catch this. This is the old `backlog/028`, confirmed still open.

**Action:** Extract `security-headers.js` to a shared location, wire it into `apps/admin/vite.config.js`, and add a header section to the admin smoke test — CLAUDE.md's own rule says the smoke test is the only thing that turns a missing `_headers` into a red pipeline.

---

### B-08 / B-09 · One-click catalogue overwrite, unconfirmed and unaudited · **P0**

**Location:** `apps/admin/src/screens/Plans.jsx:183-198` → `apps/api/src/routes/staff-console.ts:510-531`.

```jsx
onClick={() => act(() => staffApi.syncCatalogue('Reconciling every plan against Stripe'),
                   'Catalogue reconciled from Stripe.')}
```

No `ConfirmModal`, no diff, no operator-supplied reason (it is hardcoded). It runs `syncProductToPlan` over every active Stripe product, overwriting `amount_cents`, `stripe_price_id` and every entitlement column. **There is no undo** — previous values are recorded nowhere.

The button's own adjacent banner says *"overwrites every plan from Stripe with no confirmation."* Three separate design statements — including one in the same file at `:855-859` — say a one-click pull must not exist.

**And it writes no audit row.** `staffSyncCatalogue` calls `access.stripeDiff()` purely as a role gate; the only record produced is `plan.stripe_diff`. `syncProductToPlan` writes none either. On the Sync History screen the most destructive action on the platform appears as a benign "stripe_diff" — actively misrepresenting what happened, and violating `audited.ts:12-18` ("no area can perform an action without the machinery that writes it down").

**Action:** Put it behind a `ConfirmModal` with `requireReason`, `confirmText` = environment name, and a count of plans that would change; gate at `super_admin`; add `recordFleet({ action: 'plan.sync_catalogue', reason, metadata })`. Or move it out of the UI into a `wrangler` one-liner.

---

### B-10 · `main` carries an ungated production-deploy workflow · **P0**

**Location:** `main:.github/workflows/deploy-prod.yml:3-5,22`.

Triggers on **any push to `main`, no path filter**, and passes `environment: Production`. The repository's GitHub Environments are exactly **`dev` and `prod`** (verified: `gh api repos/:owner/:repo/environments`). `Production` does not exist — GitHub creates it implicitly on first use **with no protection rules**.

The file's own comment claims: *"Runs under the Production GitHub Environment, so the required-reviewer rule gates it… it is the only thing between a merged PR and live customer data."* **That gate is not in force.** The infra audit found run `33977930320` (5 Sept) where the prod job *started and executed*, unheld, failing only at a stale-secret-name check.

What is actually preventing a prod apply is an accident of renaming: `main`'s `deploy.yml` reads secret names since renamed. **Adding the missing secrets — the obvious response to that error — would perform an unreviewed `terraform apply` against prod**, then remote D1 migrations and a `wrangler deploy` of 6-September code.

Compounding: `enforce_admins: false` on `main`; the `prod` environment has `can_admins_bypass: true` and `prevent_self_review: false` with a single reviewer who is the repo owner.

**Action:** Before anything else, delete `deploy.yml`, `deploy-dev.yml`, `deploy-prod.yml` from `main` in a small PR. Then set `prevent_self_review: true`, `can_admins_bypass: false`, `enforce_admins: true`.

---

### B-11 · `main` is 191 commits stale · **P0**

`git rev-list --count main..dev` → **191**. `main` HEAD is `c919451` (6 Sept, the infra commit). `git ls-tree main apps/api/migrations/` returns **only `0001_init.sql`** — `main` predates the entire application.

The first prod release is therefore a 191-commit, ~15-migration, whole-application PR whose required checks (`App (lint, typecheck, test, build)`, `Terraform (fmt, validate)`) exercise no deploy. On merge it matches the path filters of `infra-prod.yml`, `backend-prod.yml` and both `frontend-*-prod.yml` **simultaneously** — the infra-vs-app race `infra.yml:18-23` documents, occurring on the very first prod apply.

**Action:** Sequence by hand. Merge with prod variables/secrets deliberately absent so app pipelines fail closed at their assertion steps; dispatch `infra-prod.yml` alone; verify; then add prod config and dispatch backend, then frontends.

---

### B-12 · The design specification package was deleted · **P0 (documentation integrity)**

Commit `bc1b283` ("Staff sign in with Firebase; the database says who is an admin") deleted **23 files / 4,493 lines** from `docs/design/` plus `docs/IMPLEMENTATION_PLAN.md`. The commit message does not mention it — collateral from a `git add -A`. `coordination/DEFERRED.md` X-05 records the *same directory* being swept away once before, and names the staging rule that was then broken again.

CLAUDE.md calls `docs/design/` *"The product's design authority"* and presents a 20-row catalog of links to it. **Every link is dead.**

Fully recoverable:
```
git checkout bc1b283^ -- docs/design/ docs/IMPLEMENTATION_PLAN.md
```

---

## Feature Verification Matrix

| Feature | Location | Status | Evidence | Pri | Action |
|---|---|---|---|---|---|
| Tenant isolation | `storage/workspace-scoped.ts`, `middleware/auth.ts:63` | **WORKING** | Handler never receives raw `R2Bucket`; `transferObject` takes two bound stores, no workspace id | — | none |
| Auth failure uniformity | `lib/errors.ts:69-71` | **WORKING** | All 6 key-failure modes + absent credential → identical body; 42-route sweep at `test/auth.test.ts:319` | — | none |
| Scope prefix (per-row) | `auth/scopes.ts:256-260` | **WORKING** | `path === prefix \|\| startsWith(prefix + "/")` | — | none |
| Scope prefix (listings) | `db/workspace-scoped.ts` | **BROKEN at HEAD** | Fixed in working tree only | P0 | B-01 |
| Move/copy both ends | `routes/folders.ts:198,231,272` | **WORKING** | verified | — | none |
| `deleted_at`/`disabled_at` pre-Firebase | `auth/authenticate.ts:206-211` | **WORKING** | before membership lookup | — | none |
| Billing write block | `lib/quota.ts:84` | **BROKEN** | defaulted param | P0 | B-02 |
| Plan limits: storage/files/egress | `lib/quota.ts` | **WORKING** | enforced | — | none |
| Plan limits: agents/keys/members/workspaces | `lib/plans.ts:45-57` | **INCOMPLETE** | zero enforcement call sites | P1 | build count gate |
| Request rate limit | `lib/quota.ts:90-98` | **INCOMPLETE** | `requests_period` never written; `rate-limit.ts` has 1 call site | P1 | wire into `withAuth` |
| MCP tools (8 of 10) | `mcp/tools.ts` | **WORKING** | scope-filtered at list, re-asserted at call | — | none |
| MCP `move_file`/`copy_file` | `mcp/tools.ts:271,293` | **BROKEN** | wrong field name | P0 | B-03 |
| MCP webhooks | `index.ts:523-530` | **BROKEN** | `queue` not passed to `handleMcp` | P1 | add `queue: env.JOBS` |
| Counter reconciliation | `jobs/purge.ts:127-135` | **BROKEN** | `LIMIT 200`, no cursor — workspace #201+ never reconciled | P1 | persist cursor in KV |
| Abandoned uploads | `jobs/purge.ts:61` | **BROKEN** | only `status='deleted'` swept; declare 1 byte, PUT 5 GB, never complete | P1 | add pending sweep |
| Workspace claiming (API) | `routes/claim.ts` | **WORKING** | preview/claim/merge/key-repoint all real | — | none |
| Workspace claiming (UI reachability) | `Sandbox.jsx` | **BROKEN** | claim URL discarded | P0 | B-04 |
| Checkout | `routes/billing.ts:139-242` | **BUILD_REQUIRED** | server done + 12 tests; **zero frontend callers** | P1 | render `purchasable` |
| Staff role gates (server) | `staff/audited.ts:136-144` | **WORKING** | 18 gates verified; `staff.denied` written before throw | — | none |
| Staff role gates (UI) | `Users.jsx:281` | **BROKEN** | revoke-all-keys enabled for `support`, needs `admin` | P1 | gate on `holds(role,'admin')` |
| Staff audit on reads | `staff/access.ts:129,625` | **BROKEN** | `listFleet`/`needsAttention` unaudited vs class's "no read-only exception" | P2 | add records |
| Error boundary | — | **BUILD_REQUIRED** | none exists | P1 | wrap `<App/>` |
| Security headers (web) | `apps/web/scripts/security-headers.js` | **WORKING** | generated + 16 tests + smoke assertion | — | none |
| Security headers (admin) | — | **BUILD_REQUIRED** | none | P0 | B-07 |
| Terraform workspace guard | `infra/terraform/main.tf:38-55` | **WORKING** | precondition + module re-validation | — | none |
| TF ≥ 1.11 + `use_lockfile` | `versions.tf:9,45` | **WORKING** | verified | — | none |
| Single applier | `infra.yml:140` | **WORKING** | exactly one `apply` in tree | — | none |
| `terraform output -json` hygiene | `backend.yml:190,228` | **WORKING** | written, consumed, `rm -f`'d in one step; no artifact upload | — | none |
| Committed secrets | whole tree | **WORKING** | clean; only test fixtures | — | none |
| Prod deploy gate | `main:deploy-prod.yml:22` | **BROKEN** | names a nonexistent environment | P0 | B-10 |

---

## Page-by-Page Results — Dashboard

**FileBrowser** · *Purpose:* browse/upload/manage files
Working: upload (button + drag-drop, real progress, per-file failure naming the failed step), download, delete with `allSettled` and honest partial-failure reporting, new-folder with server validation surfaced verbatim, bulk delete >5 requiring typed `DELETE`, `canWrite` gating on every write control.
Broken/static: Caption+Tags fake save (**P0**); Rename button has no handler; Sort select sets state nothing reads; list silently capped at 50 with `nextCursor` ignored (**P1**); search claims "filename, path or contents" but does client-side filename substring over the truncated page (**P1**); folders are write-only — created, then never listable or deletable (**P1**); bulk-bar Delete silently retargets to the drawer's single file when open.
**Missing error state** — a failed load sets `rows=[]` and renders "This folder is empty" (**P1**).

**Webhooks** · Fabricated failure transcript (**P0**); pausing an endpoint renders it red and labelled **"Failing"** (**P1**); "Last delivery" structurally always "Never"; failure count renders `undefined` (**P1**); 4 of 6 subscribable events are never emitted; `deliveryEnabled` hardcoded `true` server-side.

**ActivityLog** · Date-range select has no `value`/`onChange` — inert, sitting beside three filters that work (**P1**). Capped at 200 with no pagination and no statement of the cap. **Missing error state** (**P1**). Working: actor/action/text filters, expandable rows with real request id / IP / client, keyboard-operable.

**Sandbox** · Claim URL discarded (**P0**); advertises "Free plan" when the workspace gets `SANDBOX_LIMITS` (50 MB vs 1 GB) (**P1**); unreachable — no link anywhere (**P2**).

**Marketing** · "EU + US REGIONS" — a data-residency claim the same file's footer removed with the comment *"There is no region concept anywhere in this system"* (**P1**); "S3-COMPATIBLE" unsupported (**P1**); landing "three steps" instruct `adk keys create`, a CLI `Docs.jsx:22-42` states does not exist (**P1**); "GENERALLY AVAILABLE" while prod has never been applied; paid CTAs go to `/signup`.

**Legal / Settings→Privacy** · The drift CLAUDE.md warns about is **fixed** — both now agree Firebase owns sign-in. But Terms §9 promises account deletion and Privacy §13 promises data export that the product admits it cannot do (**P1, legal**); §18 points at "the address published alongside the final version" — **no contact address exists anywhere in the app** (**P1**); governing law and transfer mechanisms unspecified; "Draft — pending legal review" banner still standing.

**Verified clean:** AgentDetails, ApiKeys, Dashboard, Usage, Settings (General/Security), MembersTab, PrivacyTab, BillingTab, Profile, Claim, Support, ErrorPages (except three fake auto-timers), Auth, McpConnection (the `mcpTools`/`files:*` fixture regression is **fully gone**; all ten tool names and scopes verified against `mcp/tools.ts`).

---

## Page-by-Page Results — Staff Console

**Plans** · One-click catalogue overwrite (**P0 ×2**, B-08/B-09); no input for `description`, `is_public`, `is_default`, `sort_order` — so **the default plan cannot be changed**, while `retire()` refuses to retire the default and tells the operator to change it (dead end); "Use Reconcile all" names a button that does not exist. Strong: `QuotaField` is a correct three-way `null`/`-1`/value control; reprice warning; diff dialog ticks nothing by default.

**Workspaces** · Search promises "Name, workspace ID or owner email"; `listFleet` matches only `w.name` and `o.name` — pasting a `ws_…` ID or an owner email from a ticket returns a **confident false negative** (**P1**). `ConfirmModal` has no `error` prop and the page-level `ErrorState` is guarded by `dialog === null`, so **every server refusal on suspend/delete/restore is invisible** (**P1**). Blast-radius endpoint exists and is never called — the delete dialog under-reports what it destroys. Plan-override toasts success on `changed: false`.
*The uncommitted change here is coherent and complete* — server-side status filter, `planOverride` column, and five matching tests land together.

**Users** · "Revoke every key they created" is ungated in the UI but requires `admin` server-side; the 403 lands behind the modal (**P1**). Force-logout passes `memberships[0].workspaceId`, which is `NULL` for an org-wide membership — the usual target — producing an audit insert of `""` into a `NOT NULL REFERENCES` column **after** the revocation has committed (**P1**). "Open organization" link points at a query filter that does not exist; `transferOwner` has no UI at all, so the delete-blocker the screen raises cannot be resolved from the console.

**Billing** · `money(row.mrrCents ?? 0)` collapses `null` → `$0`, defeating the guard `money()` already provides and violating the file's own stated rule (**P2**).

**Audit** · `nextBefore` is returned by the server and appears **nowhere** in `apps/admin/src` — the log is truncated at 100 rows with no "load older" (**P1**). Strong: CSV formula-injection neutralised server-side and tested; export fetched with the bearer token; export records itself after reading.

**Verified clean:** Overview, EmailSettings (no defects found), Login/session (no bypass; `requireStaff` checks verified token + `email_verified` + row exists + not disabled on **every** request), StaffAccounts (self-disable and last-super_admin demotion refused on both sides).

**Copy defects:** session dialog says "Staff sessions last four hours and are not renewed" (Firebase tokens last ~1h and **are** auto-renewed); re-enable dialog says "same password and TOTP" (neither exists); sidebar and role-picker promise agent and key controls that exist nowhere in the UI.

---

## Interactive Element Audit — consolidated fake / static / misleading

| # | Element | Location | Class |
|---|---|---|---|
| 1 | Webhook delivery-failure transcript | `Webhooks.jsx:23-30,223` | **STATIC — fabricated data** |
| 2 | Caption + Tags ("Saved when you click away") | `FileBrowser.jsx:524-525` | **STATIC — fake success** |
| 3 | Sandbox success panel omits claim URL | `Sandbox.jsx:149-187` | **BROKEN — irreversible** |
| 4 | "Pull everything" (no confirm, no audit) | `Plans.jsx:183-198` | **BROKEN — destructive** |
| 5 | Activity date-range select | `ActivityLog.jsx:121-129` | STATIC |
| 6 | FileBrowser Sort select | `FileBrowser.jsx:394-402` | STATIC |
| 7 | FileBrowser Rename button | `FileBrowser.jsx:488` | STATIC |
| 8–10 | "Redirecting/Retrying/refreshes automatically" + spinner | `ErrorPages.jsx:48,51,127,148` | STATIC — fake behaviour |
| 11 | Webhook "Last delivery" — always "Never" | `Webhooks.jsx:69,135` | BROKEN |
| 12 | Webhook failure count renders `undefined` | `Webhooks.jsx:197` | BROKEN |
| 13 | `deliveryEnabled: true` hardcoded | `routes/webhooks.ts:114` | STATIC |
| 14 | Docs TOC — 11 inert labels incl. "Regions" | `Docs.jsx:69-73,109-122` | KEEP_STATIC (fix content) |
| 15 | Landing `adk` CLI instructions | `Marketing.jsx:66-85` | STATIC — unusable |
| 16–17 | "EU + US REGIONS", "S3-COMPATIBLE" | `Marketing.jsx:22` | **BROKEN — unsupported claims** |
| 18 | `adk_live_` prefix (real: `ask_live_`) | `Docs.jsx:40`, `Marketing.jsx:40,77` | BROKEN (copy) |
| 19 | AGENTS tile trend arrow, no trend data | `WorkspaceStats.jsx:229-241` | STATIC (decorative) |
| 20 | Failure messages in **success-toned** toasts | `Agents.jsx:340`, `ApiKeys.jsx:343`, `Webhooks.jsx:308`, `SettingsTabs.jsx:250`, `Settings.jsx:382` | BROKEN (5 screens) |
| 21 | Shell Refresh / freshness affordance | `admin Shell.jsx:320-322` vs `App.jsx:318-331` | INCOMPLETE — props never passed |
| 22 | Agents row-action column | `Agents.jsx:159-172,307-336` | REMOVE_CANDIDATE — never rendered |

**Correctly static — ship as-is.** "Configure SSO", "Export my data", "Delete my account", "Upload photo", "Delete account…", "Send request" — all six visibly disabled with the reason adjacent. This is the pattern the rest of the app should follow.

---

## Backend / Frontend Cross-Check

**Dashboard:** every `lib/api.js` call resolves to a real route. Mismatches are in the other direction.

| Backend route | Consequence |
|---|---|
| `GET /v1/search` | Unused — dashboard does a 50-row client-side filename filter instead, while advertising path+contents search |
| `POST /v1/files/:id/move` | No client method → Rename button dead |
| `POST /v1/files/:id/copy` | No copy UI |
| `GET /v1/folders`, `DELETE /v1/folders/:id` | Folders create-only |
| `POST /v1/files/:id/restore` | No trash UI (screen says so honestly) |
| `POST /v1/billing/checkout-session` + `purchasable` | **No purchase path in the product** |
| `warning` + `x-agentdisk-quota-warning` | `lib/api.js:112-114` reads neither — the soft sandbox warning never reaches a user |

**Console:** all 40 `api.js` methods resolve. Backend capabilities with **no UI**: disable/re-enable an agent (the documented support-tier abuse response — and two UI strings claim it exists), revoke a single key, transfer org ownership, blast-radius, audit `before` cursor.

**Response-shape mismatches:** Webhooks consumes `lastDeliveryAt` and `failures`, which `toResource` never returns.

---

## Static Page Audit

| Page | Verdict | Notes |
|---|---|---|
| `/docs` | **IMPROVE** | Content accurate (correctly rejects the design's fictional npm package and CLI; all ten tool names verified). But 11 inert TOC labels incl. "Regions", a rail whose 3 of 4 headings don't match, `adk_live_` prefix, and an "API keys" link going to Overview |
| `/terms`, `/privacy` | **IMPROVE — blocks launch** | Authoritative and now consistent with Firebase. But §9/§13 promise unbuilt capabilities, §18 names no address, governing law and transfer mechanisms blank, draft banner standing |
| `/` (Landing) | **IMPROVE** | Three unsupported claims + CLI instructions that cannot be followed |
| `/pricing` | **KEEP** | All four tiers verified line-by-line against `PLAN_LIMITS` — storage, agents, members, workspaces all match exactly. Only the CTAs are wrong |
| `/support` | **KEEP — exemplary**, but publish an address | Correctly states the form cannot send, disables submit with the reason beside it, refuses to render the design's invented response-time promises |
| Error pages | **KEEP** | Correctly refuse the design's mockup account data. Fix the three fake auto-timers and the "12 hours" session claim |
| `/sandbox` | **DECIDE** | Works (bar B-04) but is unreachable. Link it or remove it |

---

## Security Findings

| # | Finding | Location | Pri |
|---|---|---|---|
| S-1 | Cross-scope listing/search leak (fixed but uncommitted) | `db/workspace-scoped.ts` | **P0** |
| S-2 | Staff console: no CSP/XFO/HSTS/Referrer-Policy — framable, clickjackable | `apps/admin/vite.config.js` | **P0** |
| S-3 | Ungated prod deploy on `main` naming a nonexistent environment | `main:deploy-prod.yml:22` | **P0** |
| S-4 | Destructive catalogue overwrite, unconfirmed and unaudited | `Plans.jsx:183`, `staff-console.ts:510` | **P0** |
| S-5 | **No rate limiting on any authenticated route or MCP** | `lib/rate-limit.ts` (1 call site) | **P1** |
| S-6 | Agent API keys can read `GET /v1/billing`, which returns `ownerEmail` | `index.ts:550` (`op: null`), `billing.ts:81` | **P1** |
| S-7 | Unbounded un-billed storage via abandoned presigned uploads | `files.ts:252-266`, `presign.ts:127-134`, `purge.ts:61` | **P1** |
| S-8 | Webhook secrets stored plaintext while the schema comment claims encryption | `db/workspace-scoped.ts:698-701`, `0002_core_schema.sql:156` | **P1** |
| S-9 | Migration 0014 seeds a **personal Gmail** as prod `super_admin`, in a **public repo** | `0014:86-95` | **P1** |
| S-10 | Two orphaned live credentials in a public repo's secret store: `GH_BOOTSTRAP_PAT`, `MAILERSEND_API_TOKEN` — no consumer; `secrets: inherit` exposes them to any future workflow | repo Actions secrets | **P1** |
| S-11 | No audit on recursive folder delete, move, copy, restore, patch | `routes/folders.ts` (zero `audit` hits), `routes/files.ts` | **P1** |
| S-12 | Five cross-tenant staff reads unaudited, contradicting the class contract | `staff/access.ts:129,359,519,625` | **P2** |
| S-13 | Admin bypass of every prod control (`enforce_admins:false`, `can_admins_bypass:true`, `prevent_self_review:false`, single self-reviewer) | live branch/env protection | **P2** |
| S-14 | `POST /v1/staff/users` uses the one role gate that writes **no** `staff.denied` row | `routes/staff.ts:324-356` | **P2** |
| S-15 | Source maps published for both SPAs (2.26 MB web, 1.46 MB admin) — hands an attacker the full staff-API map | both `vite.config.js` | **P3** |
| S-16 | `SESSION_SIGNING_KEY` required at deploy, read by nothing | `backend.yml:240` | **P3** |

**Verified sound, worth recording:** no committed secrets anywhere in history; nothing secret reaches either bundle; SQL injection not found (every dynamic fragment uses fixed column literals with bound values); CSV formula injection neutralised; credentials refused in query strings (checked twice); sub-key scope subset enforced; `workers_dev`/`preview_urls` disabled and independently verified against the Cloudflare API; no impersonation feature exists; suspend-before-delete enforced server-side and tested.

**Doc 09's 21 security cases:** 11 fully covered · 4 partial · 2 moot · **4 untested or unbuilt** — SEC-10 (MIME confusion), SEC-13 (webhook replay/dedup), SEC-15 (DO-backed MCP limiter), SEC-17 (stored XSS). The gaps cluster on content-rendering safety and replay/rate-limiting.

---

## Production Configuration Findings

**First prod apply will break on these, in order:**

1. **B-10** — delete the three legacy workflows from `main` first.
2. **B-11** — sequence the 191-commit release by hand; four prod pipelines match the merge simultaneously.
3. **Prod environment is nearly empty** (verified):
   - *Variables:* prod has 8, dev 10. Prod **lacks** `FIREBASE_PROJECT_ID`, `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_APP_ID`.
   - *Secrets:* prod has only `DATABASE_ENCRYPTION_KEY`, `SESSION_SIGNING_KEY`. It **lacks** `R2_FILES_ACCESS_KEY_ID`, `R2_FILES_SECRET_ACCESS_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` → `backend.yml:338,360` `exit 1`.
   - `WEB_DOMAIN`/`WEB_WORKER_NAME` exist in **neither** environment nor at repo level, so `frontend-web-*.yml` fails closed for **dev as well as prod** — the live dashboard is not currently redeployable through CI. (`frontend.yml:165-169` documents this for prod; that it also blocks dev appears unintended.)
4. **A prod Firebase project must exist**, with `app.agentdisk.io` and `admin.agentdisk.io` on its authorized-domain list.
5. **No paid plan is purchasable** — `0012` seeds four plans with `stripe_price_id = NULL`; live-mode products must be created and synced by hand.
6. **S-9** — prod migrations grant `super_admin` to a personal Gmail the moment they run.
7. **No log retention declared** (`[observability]` absent everywhere), **no alerting, no error reporting, no uptime monitor**. `/v1/healthz` is shallow and its `commit` field is always `"dev"`.
8. **Zone DNS collisions** if `api/mcp/app/admin.agentdisk.io` already carry records; the apex `agentdisk.io` is unmanaged.
9. `npm run lint --if-present` silently skips **both** frontends (neither defines `lint`) — the barrel/hex/px conventions are unenforced and, worse, *silently* so.
10. The Worker-name assertion greps the whole `wrangler.toml` rather than the `[env.X]` block, so a match in the wrong block satisfies it.
11. The API smoke test is weaker than the frontends' — it does not check `workers.dev`, does not probe the `mcp.` hostname, and does not assert the 401 shape, despite an accidental `workers.dev` hostname having already shipped once on this very Worker.

**Verified correct and worth not re-litigating:** workspace guard, `>= 1.11` + `use_lockfile`, `assets`/`keep_assets` ignores, the D1 `read_replication` and Turnstile `sort()` workarounds, single-applier split, `-json` delete-after-use, stdin-piped secrets, queue-consumer/handler pairing, branch-protection job-name match (byte-for-byte), migration `0009`, dependency trees clean (`npm audit --omit=dev`), lockfiles present.

---

## Documentation Mismatch

**Nine material untruths, ranked:**

1. **`docs/design/` — the whole design authority — is deleted** (B-12). 20 dead links in CLAUDE.md.
2. **CLAUDE.md and `docs/STATUS.md` say the plan editor is not built. It is fully built** — create, update, retire, stripe-diff, sync-from-stripe, with 41 tests. `backlog/001` is right; CLAUDE.md is wrong, and simultaneously documents the feature's design invariants elsewhere in the same file.
3. **`docs/USER_TESTING_GUIDE.md` Part 8 is unfollowable** — it instructs the reader to run `provision-staff.mjs` (deleted) to mint a password + TOTP credential type that migration 0014 removed. A reader is blocked at step 25.
4. **CLAUDE.md's "first staff account cannot come from the API" rule is false three ways.** `provision-staff.mjs`, `src/staff/crypto.ts` and `test/staff-crypto.test.ts` **all do not exist** (verified). Staff accounts are created by `POST /v1/staff/accounts`, which works.
5. **The design-system section describes a 96-file byte-verified mirror that no longer exists** — `design-system/` holds 7 entries. `_ds_manifest.json` is absent, making the "regenerate the barrel from it" rule unfollowable.
6. **The product cannot be bought through its own UI** — not listed as a gap.
7. **Status numbers:** api 673→**674**, web 172→**195**, admin 27→**33**, admin bundle 70 KiB→**~105.7 KiB**. The 226 KiB Worker figure is unverified and identical to the figure recorded when the API had 519 tests — likely copied, not measured. Also: "sweeps 41 authenticated routes" — the array holds **42**.
8. **~58 dangling `backlog/NNN` citations across 41 files** (28 in `apps/` source alone). Only `001`–`004` exist. Worse, the numbering was **reused**: `CLAUDE.md:40`'s "See `backlog/002`" means the old design-system item and now resolves *successfully* to the staff-admin-panel document — the one citation in the repo that lands on the wrong page with no signal.
9. **Six security findings from the 8 Sept audit remain open** exactly as CLAUDE.md says: abandoned uploads, rate limiting, audit-trail gaps, webhook secret encryption, agent-key billing read, and the billing write block.

**Implemented but undocumented:** staff email settings (Mailjet + test-send), `regression-tests/` (6 specs, ~38 live tests, run by **no** CI workflow and absent from the "only index"), `Claude outputs/`, `infra/firebase/`, `POST /v1/staff/accounts`, the staff purge cron, the webhook delivery consumer, `check-jsx-identifiers.mjs`, `verify:layout`.

**summary.md (8 Sept):** 6 fixed · 6 still open · 1 moot · 1 unknown. The 8 Tier-1 false-success controls it found are **all genuinely fixed** — that work was real. One Tier-3 item survives verbatim: the FileBrowser "extracted text" search claim.

**Doc 18 Parts 7–10:** 7 fixed · 3 open. Both High-severity items (fake workspace rename; MCP path-scope bypass) are **fixed** — the §9.6 public-launch blocker is genuinely clear. What remains is two Low-severity gaps: files orphaned by agent deletion, and `agents.last_seen_at` never written.

---

## Dead Code / Technical Debt

- **Dead endpoints:** `POST /v1/staff/users` (501, obsolete body, unaudited gate).
- **Unused backend capability:** checkout-session, search, move, copy, folder list/delete, restore, blast-radius, transfer-owner, agent-disable, single-key-revoke, audit cursor.
- **Unused frontend code:** `AccentPicker`, Agents row-action column + its two modals, `api.listFolders`, `api.getFile`, `isAuthError`, `Dashboard.jsx:82-83` locals, four admin exports (incl. `auditExportUrl`, which builds a URL that *cannot* carry the Authorization header — a trap for the next author), `react-router-dom`.
- **Vestigial schema:** `users.oauth_github_id` (always NULL), `workspaces.requests_period` (never written, but published by `whoami` as if live).
- **Dead secret:** `SESSION_SIGNING_KEY`; `DATABASE_ENCRYPTION_KEY` now encrypts nothing and serves only as a config gate.
- **TODO/FIXME:** **zero** in `apps/admin/src`; the API's markers are the `backlog/NNN` citations above.
- **Published source maps** (2.26 MB + 1.46 MB).

---

## Recommended Execution Order

**0 — Before anything else (minutes, no risk)**
1. `git checkout bc1b283^ -- docs/design/ docs/IMPLEMENTATION_PLAN.md` (B-12)
2. Commit the scope-prefix fix already in the working tree (B-01)
3. Delete `deploy.yml`, `deploy-dev.yml`, `deploy-prod.yml` from `main` in a small standalone PR (B-10)
4. Revoke `GH_BOOTSTRAP_PAT` and `MAILERSEND_API_TOKEN` at the provider, then delete the repo secrets (S-10)

**1 — Critical blockers**
5. Make `billingStatus` required; thread it through `withAuth` (B-02) + test
6. Map `newPath` → `path` in MCP move/copy; add a `TOOLS`-iterating `tools/call` test (B-03)
7. Render the claim URL in Sandbox (B-04)
8. Wire or remove Caption/Tags — and the hint (B-05)
9. Delete the fabricated webhook failure panel (B-06)
10. Port the security-headers plugin to `apps/admin` + smoke-test assertion (B-07)
11. Confirm + audit the catalogue sync; gate at `super_admin` (B-08/B-09)

**2 — Broken core workflows**
12. `ConfirmModal`: add `error`; raise the reason gate to 3 chars; drop the `dialog === null` guard
13. Fix console force-logout's `workspaceId`; gate revoke-all-keys on `admin`
14. Fix fleet search to cover workspace ID and owner email (or correct the copy)
15. Webhooks: render `status` as Active/Paused; drop "Last delivery" and the `undefined` count
16. Add error states to FileBrowser and ActivityLog; add a global error boundary
17. Remove the inert Activity date-range and FileBrowser Sort controls
18. Add `queue: env.JOBS` to `handleMcp`; extract one shared deps builder
19. Fix `reconcileCounters` pagination (KV cursor)
20. Add the audit-log "load older" cursor

**3 — Missing backend / enforcement**
21. Rate limiting on the authenticated surface + MCP (S-5)
22. Count gates for agents / keys / members / workspaces
23. Abandoned-upload sweep + R2 orphan reconciliation (S-7)
24. Checkout UI from `purchasable` (B-24)
25. Encrypt webhook secrets, or correct the schema comment (S-8)
26. Audit rows for folder delete, move, copy, restore, patch (S-11)
27. Restrict `GET /v1/billing` from agent keys (S-6)

**4 — Security & configuration**
28. Populate the prod environment (4 secrets, 3+ variables, `WEB_DOMAIN`/`WEB_WORKER_NAME` for both envs)
29. Replace the personal Gmail seed with a deliberate prod bootstrap (S-9)
30. `enforce_admins: true`, `prevent_self_review: true`, `can_admins_bypass: false` (S-13)
31. `sourcemap: 'hidden'` in both apps (S-15)
32. Declare log retention; add alerting and an uptime monitor; deepen `/v1/healthz`
33. Add `lint` scripts to both frontends, even if they only run the `Skill/1 Build.md` greps
34. Strengthen the API smoke test (workers.dev, mcp hostname, 401 shape)
35. Wire `regression-tests/` into CI

**5 — Important UX / copy**
36. Remove "EU + US REGIONS", "S3-COMPATIBLE", "GENERALLY AVAILABLE"; replace the `adk` CLI steps
37. Fix `adk_live_` → `ask_live_` in three places
38. Publish a support email address; fix Terms §9 / Privacy §13/§18; set governing law and transfer mechanisms; decide on the draft banner
39. Carry a tone with toast messages (5 screens)
40. Fix the stale console copy ("four hours", "password and TOTP", agent/key promises)
41. Move `/account/profile` inside `RequireAuth`

**6 — Static / remove candidates**
42. Decide on `/sandbox` (link or delete); the three fake error-page timers; the Docs TOC; `AccentPicker`; the Agents row-action column; `POST /v1/staff/users`; `react-router-dom`

**7 — Cleanup**
43. Rewrite CLAUDE.md's stale sections (staff bootstrap, design system, status numbers, plan editor); update `STATUS.md`, `Skill/1 Build.md`, `DEFERRED.md`, `USER_TESTING_GUIDE.md` Part 8; resolve the 58 dangling citations and the `backlog/002` collision

**8 — Final regression**
44. Full suite + `regression-tests/` against dev; then the hand-sequenced prod release (B-11)

---

## Final Production Checklist

- [x] Build passes — all three apps
- [x] Tests pass — 674 / 195 / 33
- [x] Authentication verified — uniform failure body, 42-route sweep, no bypass found
- [ ] **Authorization verified** — blocked by B-01 (uncommitted), S-6, and the console UI role gap
- [ ] **Core workflows verified** — blocked by B-04, B-05, and folder/pagination gaps
- [ ] **Secondary workflows verified** — no purchase path; webhooks misreport state
- [x] Static pages reviewed — legal and marketing copy changes required before launch
- [x] All interactive elements reviewed — 22 fake/static/misleading catalogued
- [ ] **Error states verified** — FileBrowser and ActivityLog render "empty" on failure; no error boundary
- [x] Empty states verified — present and generally well done
- [x] API/backend verified — full route table produced; 11 `withAuth` bypasses checked
- [x] Database verified — migrations sequential, indexes present, 0009 matches its documented behaviour
- [ ] **Security reviewed** — 4 P0, 7 P1 open
- [ ] **Production configuration reviewed** — prod environment nearly empty; `main` unsafe
- [ ] **Documentation reconciled** — design package deleted; 9 material untruths
- [ ] **Dead functionality removed or intentionally retained** — catalogued, not yet actioned
- [ ] **Final regression test completed**

---

## Closing note on quality

It is worth separating two things this audit found. The **engineering** is good: the isolation model, the scope algebra, the audit inheritance, the overlay focus contract, the Terraform layer and the null-vs-`-1` discipline are carefully built, and dozens of invariants claimed in comments turned out to be genuinely enforced. Several defects here are *regressions of already-solved problems* — the team has fixed this exact class of bug before and documented why.

The pattern worth naming: every screen that received a deliberate "remove the fabricated element" pass carries a header comment enumerating what it removed — and **every one of those verified clean**. The remaining defects cluster almost entirely in the five files that never got that pass: `Webhooks.jsx`, `FileBrowser.jsx`, `ActivityLog.jsx`, `Sandbox.jsx`, `Marketing.jsx`. Applying the same treatment to those five would clear roughly two-thirds of the dashboard findings.
