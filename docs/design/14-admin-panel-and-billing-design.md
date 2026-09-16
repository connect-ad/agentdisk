# AgentDisk — Admin (Staff) Panel & Stripe Billing Design
### PART 27–29 of the AgentStorage-Inspired Platform Design

*New scope, added after the initial build began. Confirmed with the product owner: "User panel" = the customer-facing dashboard already fully specified in `03-ux-architecture-and-screens.md`/`04-claude-design-prompt.md` — build that as-is. "Admin panel" = a genuinely separate internal tool **for AgentDisk's own team**, not the existing owner/admin *customer* role views — that has no prior design, which is what PART 27–28 below provide. Stripe depth is confirmed as the lighter of two options: the existing `03` §8.25 Billing screen (plan card + a redirect into Stripe's own hosted Customer Portal), not a custom-built checkout/billing UI — PART 29 designs exactly that, no more.*

All content is **PROPOSAL** unless marked otherwise.

---

## PART 27 — Staff Authentication & Authorization Model

### 27.1 Why This Is a Separate System, Not a Reused Role

Every security guarantee in `06-security-privacy-legal.md` PART 16.1 rests on one invariant: a request's `workspace_id` is resolved server-side from the caller's identity and a handler is *structurally* unable to query outside it. A staff console's entire purpose is to violate that invariant on purpose — a support engineer needs to look at *any* customer's workspace. That means staff access cannot be "a customer role with higher permissions" bolted onto the existing `users`/`memberships` model; it has to be a **deliberate, separate, explicit exception**, so that the customer-facing security model keeps its "never" as an actual never, not a "never, except for staff, which is a special case scattered through the same code paths."

Concretely: staff accounts, staff sessions, and staff route handlers are entirely separate from everything in `05` PART 11.1 — different tables, different login route, different cookie, different repository class — so a reviewer can look at `WorkspaceScopedFiles` and correctly conclude "this can never cross a tenant boundary," full stop, with the staff exception living somewhere else entirely and auditable on its own terms.

**Also deliberately separate from Firebase (added Sept 2026, when customer auth moved to Firebase — `16-firebase-auth-and-final-launch-prompt.md` PART 30).** Staff auth stays exactly as designed below — password + mandatory TOTP against AgentDisk's own `staff_users` table — rather than also moving to Firebase. Two reasons: staff is a small, manually-provisioned internal team where Firebase's consumer-signup conveniences (self-service, social login) buy nothing and would need to be actively disabled anyway; and keeping staff auth fully independent means a Firebase outage (or a Firebase-side account issue) never blocks AgentDisk's own team from being able to log in and investigate what's happening to customers during exactly the kind of incident staff access exists for.

### 27.2 Staff Identity & Session — Schema

```sql
-- Staff accounts: provisioned manually by a super_admin, never self-service, never linked to the customer `users` table
CREATE TABLE staff_users (
  id TEXT PRIMARY KEY,               -- 'stf_' + ULID
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,       -- Argon2id, same as `06` PART 16.5 — same bar, same fallback rule
  totp_secret TEXT NOT NULL,         -- application-level encrypted (AES-256-GCM, DATABASE_ENCRYPTION_KEY — same pattern as `06` PART 16.16a's webhook secrets), decrypted only in-memory at login-verification time
  role TEXT NOT NULL,                -- 'support' | 'admin' | 'super_admin'
  disabled_at INTEGER,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Staff sessions: intentionally simpler than customer refresh_tokens (05 PART 11.1a) — short-lived, no
-- rotation family, no "remember me". A staff session that's stolen is a much higher-value compromise
-- than a customer session, so the answer is a shorter blast-radius window, not more session machinery.
CREATE TABLE staff_sessions (
  id TEXT PRIMARY KEY,               -- 'ssn_' + ULID
  staff_user_id TEXT NOT NULL REFERENCES staff_users(id),
  token_hash TEXT NOT NULL UNIQUE,   -- SHA-256, never store plaintext — same discipline as api_keys.key_hash
  expires_at INTEGER NOT NULL,       -- 4 hours from issuance, not 30 days
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_staff_sessions_user ON staff_sessions(staff_user_id);
```

`audit_events.actor_type` (`05` PART 11.1) gains a fourth value: `'staff'` (was `'user' | 'agent' | 'system'`).

### 27.3 Authentication Rules — Deliberately Stricter Than Customer Auth

Login route is `/staff/login` (or, in practice, a route only reachable via the `admin.agentdisk.io` origin — PART 28.1) — never the same endpoint as customer `/login`, so there is no code path where a customer credential could ever be evaluated against staff logic or vice versa. **TOTP (2FA) is mandatory for every staff account, no exceptions** — unlike customer auth, where MVP-0/1 requires none. This isn't inconsistency; it's proportionality: a staff credential is the single highest-value target in the entire system (it's the one credential type with cross-tenant reach), so it gets the categorically higher bar. No magic-link option for staff — password + TOTP only, both required, every login.

Session cookie is named distinctly from the customer session cookie (e.g. `staff_session`, scoped to `admin.agentdisk.io` only) and expires in 4 hours with no refresh-token rotation model — a staff member re-authenticates more often than a customer does, on purpose.

### 27.4 Authorization — the `StaffScopedAccess` Pattern

Mirrors `06` PART 16.1's concrete-pattern discipline, but inverted on purpose:

```ts
// Deliberately the mirror image of WorkspaceScopedFiles: no workspace_id in the constructor,
// because this class's entire job is cross-workspace access. It must be impossible to
// instantiate outside a /v1/staff/* route, and every method call is unconditionally audited.
class StaffScopedAccess {
  constructor(private db: D1Database, private staffUser: StaffIdentity) {}

  async getWorkspace(workspaceId: string) {
    const row = await this.db.prepare(`SELECT * FROM workspaces WHERE id = ?`).bind(workspaceId).first();
    await this.audit('workspace.staff_view', workspaceId);
    return row;
  }

  async suspendWorkspace(workspaceId: string, reason: string) {
    if (this.staffUser.role === 'support') throw new ForbiddenError('support role cannot suspend workspaces');
    await this.db.prepare(`UPDATE workspaces SET status = 'suspended' WHERE id = ?`).bind(workspaceId).run();
    await this.audit('workspace.suspend', workspaceId, { reason });
  }

  private async audit(action: string, workspaceId: string, metadata: object = {}) {
    // actor_type: 'staff', actor_id: this.staffUser.id, plus the workspace acted on —
    // this is what makes cross-tenant staff access reviewable rather than invisible.
    await appendAuditEvent(this.db, {
      actorType: 'staff', actorId: this.staffUser.id, workspaceId, action,
      metadata: { ...metadata, staffRole: this.staffUser.role },
    });
  }
}
```

Every method **always** appends an audit event — there is no "read-only, so it doesn't need logging" exception, because "which staff member looked at which customer's data, when" is precisely the fact the whole model exists to make reviewable.

**Role matrix:**

| Capability | `support` | `admin` | `super_admin` |
|---|---|---|---|
| View any workspace/usage/audit log | ✅ | ✅ | ✅ |
| View/search any user, any org | ✅ | ✅ | ✅ |
| Disable/re-enable an agent or API key (abuse response) | ✅ | ✅ | ✅ |
| Force a customer password reset / force logout | ✅ | ✅ | ✅ |
| Suspend / reinstate a workspace | ❌ | ✅ | ✅ |
| Issue a plan override or temporary quota bump | ❌ | ✅ | ✅ |
| Delete a workspace (hard, staff-initiated) | ❌ | ❌ | ✅ |
| Manage staff accounts (create/disable/assign role) | ❌ | ❌ | ✅ |

Three roles, mirroring the existing owner/admin/member shape (`06` PART 15.2) for consistency, not because three happens to be a magic number — same reasoning as that section: add a fourth only if real operational need demands it.

### 27.5 API Surface

All staff endpoints live under `/v1/staff/*` on the **same Worker fleet** already serving REST/MCP (no new Worker, no new D1, no new R2 — consistent with `05` PART 10.1's "no unnecessary infrastructure" and `11`'s coding principles). They are reachable only via `staff_session` cookie auth (never a bearer API key — API keys are an agent/customer concept and must never carry staff privilege) and are the *only* place `StaffScopedAccess` may be constructed — a lint rule should enforce this the same way `06` PART 16.10 enforces parameterized queries.

| Method & URL | Role required | Notes |
|---|---|---|
| `POST /v1/staff/login` | none (public, rate-limited hard — this is the highest-value login endpoint in the system) | password + TOTP, both required in one request |
| `POST /v1/staff/logout` | any staff | revokes the current `staff_sessions` row |
| `GET /v1/staff/workspaces` | support+ | search/paginate every workspace, cursor-based like `05` PART 13 |
| `GET /v1/staff/workspaces/:id` | support+ | full detail incl. plan, usage, owner, audit log |
| `PATCH /v1/staff/workspaces/:id/suspend` | admin+ | |
| `PATCH /v1/staff/workspaces/:id/plan-override` | admin+ | |
| `DELETE /v1/staff/workspaces/:id` | super_admin | hard delete, distinct from the customer's own soft-delete-with-grace-period flow — logged with extra prominence |
| `GET /v1/staff/users` | support+ | search by email |
| `PATCH /v1/staff/users/:id/disable` | support+ | |
| `POST /v1/staff/users/:id/force-logout` | support+ | sets `users.session_revoked_after = now()` (`05` PART 11.1, `16` PART 30.4) — superseded from the original "revokes every `refresh_tokens` row" description now that human sessions are Firebase-backed, but the endpoint's job is unchanged: force every currently-open session for this user to re-authenticate |
| `POST /v1/staff/users/:id/revoke-keys` | support+ | **added Sept 2026** — revokes (sets `revoked_at`, busts the KV cache) every `api_keys` row with `created_by_user_id` = this user, across every workspace they belong to; the parallel, for-cause version of the opt-out-by-default checkbox on `03` §8.22's self-service "remove member" flow — use this one when the removal reason is abuse/compromise/termination-for-cause rather than a routine role change, since it reaches keys in *every* workspace the user touched, not just one |
| `GET /v1/staff/audit` | support+ | the global cross-workspace log — every `actor_type='staff'` event, filterable by staff member/action/date |
| `GET /v1/staff/accounts` / `POST` / `PATCH .../disable` | super_admin | manage `staff_users` rows |

---

## PART 28 — Admin (Staff) Panel — Screens

### 28.1 Where It Runs

New deployable, `apps/admin` (Cloudflare Pages, same pattern as `apps/web` in `07` PART 18.6), served at `admin.agentdisk.io` (prod) / `admin-dev.agentdisk.io` (dev) — its own origin, never sharing a cookie scope with `app.agentdisk.io`, which is what makes "staff session cookie can never be confused with a customer session cookie" true at the browser level, not just by naming convention. It talks to the same `api.agentdisk.io`/`api-dev.agentdisk.io` Worker, under `/v1/staff/*`.

**Visual register:** deliberately plainer than the customer dashboard — this is an internal tool judged on speed and correctness, not brand polish. Reuse the same design-system tokens/components from `04`'s spec (so it isn't a second design system to maintain) but skip anything decorative; dense tables over cards, no marketing-adjacent copy.

### 28.2 Screens

**1. Staff Login (`/login`)** — email, password, TOTP code (single combined form, all three required before submit — don't reveal password correctness before TOTP is also checked, so a partial-credential attempt gives no signal either way). Generic failure message, same non-enumerating principle as `06` PART 16.2/16.3. No signup link, no "forgot password" self-service (a locked-out staff member contacts a `super_admin` directly — this is intentionally not self-service).

**2. Overview (`/`)** — fleet-wide stat tiles: total workspaces, active in last 7 days, total storage across every workspace, total requests today, signups this week. Below: a "Needs attention" list — workspaces past 95% quota, past-due billing status, or with 3+ failing webhooks — this is the screen a support engineer opens first each day.

**3. Workspaces (`/workspaces`)** — search (by name, ID, or owner email) + filter (plan, status, billing status) → table (name, plan, owner email, storage used, status, billing status, created). Row click → Workspace Detail.

**4. Workspace Detail (`/workspaces/:id`)** — read-only mirror of the customer's own Overview + Usage screens (`03` §8/§15), plus a staff-only actions panel: "Suspend workspace" / "Reinstate" (admin+), "Adjust plan override" (admin+, a modal setting `workspaces.plan_override` directly), "Delete workspace" (super_admin, requires typing the workspace name exactly like the customer-facing danger zone, `03` §8.21). A tab for this workspace's audit log (not the global one — scoped, but staff-viewable regardless of the customer's own retention window per `06` PART 17.2 §7).

**5. Users (`/users`)** — search by email → row shows every org/workspace membership for that user → actions: "Disable account," "Force logout everywhere," "Force password reset" (sends the same reset email the customer's own forgot-password flow would send, `03` §5).

**6. Billing (`/billing`)** — table of every org with a `stripe_customer_id`: plan, billing status (`active`/`past_due`/`canceled`), next invoice date, MRR contribution. Each row links out to that customer's record in **Stripe's own dashboard** — staff manage anything Stripe-specific (refunds, disputes, manual invoice edits) in Stripe directly; this screen is a read-only status view, not a rebuilt billing console, exactly matching the "lighter" Stripe depth decision (PART 29).

**7. Audit Log (`/audit`)** — every `actor_type='staff'` event, fleet-wide, filterable by staff member, action, and date range. This is the accountability screen for the whole staff-access model — treat it as load-bearing, not an afterthought: every capability in the PART 27.4 role matrix should be independently verifiable here.

**8. Staff Accounts (`/staff`, super_admin only)** — list/create/disable staff accounts, assign role. Creating an account generates a TOTP enrollment QR code shown exactly once (same reveal-once interaction pattern as the customer API-key/webhook-secret flows, `03` §8.16/§8.18a — reused, not reinvented).

**9. Plans & Pricing (`/plans`, admin+ view, admin+ edit) — added Sept 2026.** Table of every plan (`plans` table, PART 29.2a below) — name, price, quotas (storage/files/egress/requests/agents/keys/members, the same dimensions as `07` PART 19.0's table), and its Stripe sync status (`in sync` / `local changes not pushed` / `Stripe changed since last sync`, computed by comparing stored `stripe_price_id`/hash against a fresh Stripe read). Editing a plan's price or quotas and saving calls **"Push to Stripe"** automatically (creates or updates the matching Stripe Product + Price and stores the returned IDs) — this is the primary, day-to-day path. A separate, explicit **"Sync from Stripe"** button (per-plan, or fleet-wide) pulls the current Stripe catalog and shows a diff against AgentDisk's local `plans` rows before applying anything — for the case where someone changed a price directly in the Stripe Dashboard and AgentDisk needs to catch up; it never silently overwrites, always shows what would change and asks for confirmation first. Both directions write the same `plans` row and log an audit event, so "who changed the Pro plan's price and from which side" is always answerable from the Audit Log screen (§7). `admin`-role staff can push/pull; only `super_admin` can add or retire a whole plan (retiring hides it from new signups but doesn't affect existing subscribers on it, matching Stripe's own Price-archival semantics).

### 28.3 Explicit Non-Goals

No impersonation/"log in as this customer" feature in this pass — every staff capability above acts *on* a workspace (suspend, override, disable) rather than *as* the customer inside it. If a real support need for full impersonation emerges later, it's a deliberately separate, even-more-tightly-audited decision, not something to add quietly to this role matrix.

---

## PART 29 — Stripe Billing Integration (Portal-Depth, Per Confirmed Scope)

### 29.1 What This Is and Isn't

Confirmed scope: the existing `03` §8.25 Billing screen (plan card, "Manage billing" button) backed by Stripe's own **hosted Customer Portal** — not a custom-built checkout or plan-management UI. This keeps AgentDisk out of PCI scope entirely (card data never touches AgentDisk's own servers, ever) and matches `02` PART 6's original MVP-1 sequencing.

### 29.2 Data Model — No New Table Needed

`organizations.stripe_customer_id` already exists (`05` PART 11.1) — it was specified from the start, just never wired up. One addition:

```sql
ALTER TABLE organizations ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'active';
-- 'active' | 'past_due' | 'canceled' — drives the write-blocking behavior in 29.4
```

### 29.3 Flows

**Customer creation:** at org creation (or first workspace claim, matching the existing agent-first bootstrap flow, `05` PART 4.3), the Worker calls Stripe's API to create a Customer object, storing the returned ID in `organizations.stripe_customer_id`. Idempotent — reuse `Idempotency-Key` (`05` PART 13) so a retried org-creation request never creates two Stripe customers for one org.

**Opening the portal:** new endpoint `POST /v1/billing/portal-session` — session-authenticated, owner/admin role — calls Stripe's Billing Portal Session API for that org's `stripe_customer_id`, returns `{url}`. The dashboard's "Manage billing" button (`03` §8.25) redirects the browser there; Stripe's own hosted page handles plan changes, card updates, and invoice history from that point on.

**Staying in sync:** `POST /v1/webhooks/stripe` — a new endpoint, deliberately distinct from the product's own customer-facing `webhooks` table (`05` PART 11.1) and its `/v1/webhooks` CRUD (that feature is customers registering *their own* endpoints; this is AgentDisk receiving events *from* Stripe as a Stripe customer itself — same word, two unrelated concepts, worth keeping visibly separate in the codebase). Verifies Stripe's signature via their SDK's own verification call (not a hand-rolled HMAC check — use the vendor's library for this one, since getting it subtly wrong has real billing consequences). Handles at minimum: `customer.subscription.updated` (sync `organizations.plan` from the Stripe price/product), `customer.subscription.deleted` (set `billing_status = 'canceled'`), `invoice.payment_failed` (set `billing_status = 'past_due'`), `invoice.payment_succeeded` (clear `past_due` back to `active` if it was set).

### 29.4 Enforcement

`billing_status` is checked as one more condition in the existing quota-check middleware step (`06` PART 15.2's step 5, `checkQuota`) — no new middleware stage needed. `past_due` or `canceled` blocks new writes (same `LIMIT_EXCEEDED`-shaped error as any other quota block, `05` PART 13/`06` PART 17.4) while reads continue to work, matching the downgrade behavior already specified in `03` §8.25 ("new uploads will be blocked until you're back under the limit") and the ToS language already drafted in `06` PART 17.3 §10.

### 29.5 Secrets

`STRIPE_SECRET_KEY` was already listed in `07` PART 18.2's secrets table (specified, never wired) — add `STRIPE_WEBHOOK_SECRET` alongside it, same `wrangler secret put` discipline, same per-environment separation (a dev Stripe account/test-mode keys, never live keys in the dev environment).

### 29.6 Plan Management & Two-Way Stripe Sync (Added Sept 2026)

**Confirmed scope:** staff can edit plan/package definitions (price, quotas) from the Admin Panel's new Plans & Pricing screen (`28.2` §9), with changes pushed to Stripe automatically; a separate manual "Sync from Stripe" action pulls Stripe's own catalog back into AgentDisk for the case where a change was made directly in Stripe's dashboard instead. This is new backend surface beyond the original PART 29.1–29.5 (which covered only the *customer-facing* portal-redirect flow) — the pricing/plan data itself was previously a hardcoded table in `07` PART 19.0, never a database row an admin could edit.

**29.6a Schema — new `plans` table:**

```sql
-- Plans: the editable source of the numbers in `07` PART 19.0's table. organizations.plan
-- and workspaces.plan_override (05 PART 11.1) store this table's `key`, not a free-floating string.
CREATE TABLE plans (
  id TEXT PRIMARY KEY,                -- 'pln_' + ULID
  key TEXT NOT NULL UNIQUE,           -- 'free' | 'pro' | 'team' | future plan keys — stable, referenced elsewhere
  name TEXT NOT NULL,                 -- display name, editable independent of `key`
  price_cents INTEGER NOT NULL,       -- monthly price in cents, USD; 0 for the free plan
  quotas TEXT NOT NULL,               -- JSON: {storageBytes, maxFiles, egressBytes, requestsPerMonth,
                                       --        maxFileSizeBytes, maxAgents, maxApiKeys, maxMembers}
                                       -- — same dimensions as 07 PART 19.0's table
  stripe_product_id TEXT,             -- NULL until first "Push to Stripe"
  stripe_price_id TEXT,               -- NULL until first "Push to Stripe"; a price *change* creates a
                                       -- new Stripe Price (Stripe Prices are immutable) and repoints this
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'retired' — retired hides from new signups only
  last_synced_at INTEGER,             -- last successful push-to or pull-from Stripe
  last_synced_direction TEXT,         -- 'pushed_to_stripe' | 'pulled_from_stripe'
  updated_by_staff_id TEXT REFERENCES staff_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**29.6b Endpoints (added to the `/v1/staff/*` surface, PART 27.5):**

| Method & URL | Role required | Notes |
|---|---|---|
| `GET /v1/staff/plans` | support+ (read-only for support) | includes each plan's live sync-status, computed by comparing local vs. a cached recent Stripe read — not a live Stripe call on every list, to keep this screen fast (`07` PART 19.0-scale data, refreshed on a short TTL) |
| `PATCH /v1/staff/plans/:id` | admin+ | updates `name`/`price_cents`/`quotas`; **automatically triggers a push to Stripe** in the same request (creates a new Stripe Price if `price_cents` changed, since Stripe Prices are immutable; updates the Product's metadata/name otherwise) — the endpoint is transactional in effect: if the Stripe call fails, the local row is not updated either, and the UI shows the Stripe error directly rather than silently saving a local-only change that's now out of sync |
| `POST /v1/staff/plans` | super_admin | create a new plan; same push-to-Stripe behavior on creation |
| `POST /v1/staff/plans/:id/retire` | super_admin | sets `status = 'retired'`; does not touch existing subscribers (`organizations.plan` is untouched — this only removes it from future signup options) |
| `GET /v1/staff/plans/stripe-diff` | admin+ | live Stripe catalog read, diffed against local `plans` rows; returns the diff without applying anything — what the Plans screen's "Sync from Stripe" button calls first, to render the confirmation view |
| `POST /v1/staff/plans/sync-from-stripe` | admin+ | applies a previously-shown diff (the request body names which fields on which plans to accept from Stripe) — never a blind "pull everything," always confirmation-then-apply |

**29.6c Conflict handling:** the system does not attempt automatic three-way merge. "Push to Stripe" (on every local edit) always wins on the AgentDisk → Stripe direction; "Sync from Stripe" always requires a human to review the diff before it's applied on the Stripe → AgentDisk direction. If both happened between two syncs (someone edited in Stripe *and* someone edited in the Admin Panel before reconciling), the diff view surfaces both sides' current values side by side and a staff member picks per-field — this is a deliberately manual last-mile step rather than a silent last-write-wins, because a wrong automatic resolution here means real customers get billed the wrong amount.

**29.6d Relationship to 29.1–29.5:** unchanged — this section only affects how a plan's *definition* is authored and kept in sync with Stripe. The customer-facing flows (portal redirect, webhook-driven `billing_status`, quota enforcement) still work exactly as PART 29.1–29.5 describe, reading from the `plans` table (via `organizations.plan`/`workspaces.plan_override`) wherever they previously read `07` PART 19.0's static table.
