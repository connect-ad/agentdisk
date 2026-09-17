# Billing module — design

**Date:** 17 September 2026
**Branch:** `dev` (no other branch; rollback tag `pre-billing-module` on `c0bbc1c`)
**Supersedes for pricing numbers:** 07 PART 19.0, `apps/web/src/lib/pricing.js`, backlog [024](../../../backlog/024-pricing-page-drift.md)
**Reference pattern:** `37-billing-architecture-reference-amardrive.md` (sibling project)

---

## Why this exists

AgentDisk has most of a billing system and no way to pay for anything.

The parts that work: a Workers-safe Stripe client, a signature-verified webhook
endpoint, org billing columns, a `plans` table, and a dashboard that opens
Stripe's hosted portal. The parts that do not:

- **No Checkout.** `stripe.checkout.sessions.create` appears nowhere. The portal
  only serves somebody who already has a subscription, and nothing can create
  one. Pro and Team are unbuyable.
- **The `plans` table is never written.** One query reads it
  (`organizations.ts:111`, `findPlanByPriceId`); nothing seeds, syncs or updates
  it. So even a successful checkout resolves its price to `null`, and
  `organizations.plan` stays `free` forever. A paying customer would receive
  free entitlements. This is the load-bearing break.
- **The past-due write block is dead.** `assertQuotaAndWarn`
  (`middleware/auth.ts:356`) calls `assertWithinQuota` without the
  `billingStatus` argument, so it takes the `"active"` default; and no route
  sets `requirement.demand`, so the middleware path never reads the billing row
  either. `backlog/017` item 1, still open.
- **Nothing counts.** `createAgent`, `createKey`, `inviteMember` and the
  authenticated `createWorkspace` path all insert with no quota check at all.
  `PLAN_LIMITS.agents`, `.apiKeys` and `.members` are read by nothing.

## Decisions taken

Every one of these was decided by the user on 17 September 2026. Recorded here
because several override what the code or the older documents say, and the
reasons are not recoverable from the diff.

| # | Decision | Consequence |
|---|---|---|
| D1 | The new limits apply to **everyone**, no grandfathering | Free drops 2 GB → 1 GB and 3 agents → 1; Pro 20 agents → 10; Team 100 → 50. Existing dev workspaces over the line start refusing writes. Accepted deliberately: dev has no paying customers, and two definitions of "Free" is a worse thing to carry. |
| D2 | Egress and requests are **unlimited on every plan** | R2 egress costs $0, so it is free to promise. The check code stays and the values become unlimited, so a cap can return as data rather than as a re-implementation. This also moots `backlog/017` items 2 and 3. |
| D3 | Permanent share links, webhooks and path-scoped keys are **available on every plan, ungated** | Reverses the canonical table, which marked all three "No" for Free. No API gating is built, and the pricing page shows them as included everywhere rather than printing a "No" the API does not enforce. |
| D4 | **D1 `plans` drives entitlements; `lib/plans.ts` is the fallback floor** | amardrive's pattern. Pricing changes without a deploy. Any field D1 cannot supply resolves to the hardcoded tier — never wider. |
| D5 | Workspaces per plan **1 / 3 / 10 / 50**; API keys **2 / 6 / 20 / 100** | Resolves the table's open "API keys = Workspaces × 2" formula. Tracks the agent-identity curve and keeps Free genuinely single-workspace, which the claim/sandbox flow already assumes. |
| D6 | **Terraform creates the Stripe Products and Prices** | Advised against and reaffirmed. Mitigations in "Terraform owns live billing objects" below. |
| D7 | Agents, API keys, members and workspaces are counted **per organization** | Account-wide totals, which is what a billing limit means and what the `Workspaces × 2` formula implies. Requires a narrow count-only cross-workspace query. |
| D8 | Tag `pre-billing-module` before starting; `Billing-module-developed` when it lands | Rollback point. |

## The entitlement table

Authoritative. Replaces every other pricing table in the repository.

| | Free | Basic | Pro | Team |
|---|---|---|---|---|
| `plans.id` / `organizations.plan` | `free` | `basic` | `pro` | `team` |
| Stripe `metadata.package_id` | `agentdisk-free` | `agentdisk-basic` | `agentdisk-pro` | `agentdisk-team` |
| Price / month | $0 | $9 | $20 | $80 |
| Storage | 1 GB | 5 GB | 50 GB | 500 GB |
| Egress | unlimited | unlimited | unlimited | unlimited |
| Requests / month | unlimited | unlimited | unlimited | unlimited |
| Agent identities | 1 | 5 | 10 | 50 |
| Members | 1 | 2 | 5 | 25 |
| Workspaces | 1 | 3 | 10 | 50 |
| API keys | 2 | 6 | 20 | 100 |
| Permanent share links | yes | yes | yes | yes |
| Webhooks | yes | yes | yes | yes |
| Path-scoped keys | yes | yes | yes | yes |
| Priority support | no | no | yes | yes |
| File count | unlimited | unlimited | unlimited | unlimited |
| Max file size | 100 MB | 500 MB | 1 GB | 5 GB |

Three rows the canonical table did not name, filled in and flagged to the user:

- **File count** becomes unlimited. It is not in the table, storage already
  bounds it, and a second aggregate cap is a second number to contradict.
- **Max file size** keeps today's enforced values; Basic is interpolated at
  500 MB. It is a per-request ceiling, not an allowance, so it is not a thing
  the pricing table was ever describing.
- **Priority support** is display-only. There is nothing in the request path to
  enforce and inventing one would be theatre.

`SANDBOX_LIMITS` is untouched. An unclaimed sandbox is a claim state derived
from `claimed_at`, not a plan, and nothing here makes it selectable.

## Architecture

```
  infra/stripe-catalogue/catalogue.tf      (its own root, its own pipeline)
        │  stripe_product  (entitlements in metadata)
        │  stripe_price    (one per paid plan)
        ▼
  Stripe                                    ← source of truth for price + identity
        │  product.created/updated  ─┐
        │  checkout.session.completed │      webhook, signature-verified
        │  customer.subscription.*    │
        ▼                             │
  D1 `plans`  ◄──── staff sync ───────┘      ← read cache, one shared upsert
        │
        ▼
  billing/catalogue.ts                       ← D1 row over lib/plans.ts floor
        │
        ▼
  quota + count gates                        ← what actually refuses a request
```

### Where truth lives

No price ID is injected into `wrangler.toml`. The Worker discovers the
catalogue from Stripe by `metadata.package_id` and mirrors it into D1, so there
is one definition rather than a copy in configuration that can drift from it.

| Object | Authoritative | D1 mirror |
|---|---|---|
| Plan identity, entitlements | Stripe `Product.metadata` | `plans.*` |
| Price, currency, interval | Stripe `Price` (immutable) | `plans.amount_cents`, `plans.stripe_price_id` |
| Subscription lifecycle | Stripe `Subscription` | `organizations.billing_status`, `.stripe_subscription_id` |
| Enforcement floor | `lib/plans.ts` | — (code, not data) |

`metadata.package_id` is the join key, exactly as amardrive does it. A Stripe
product without it is ignored by the sync, so an unrelated one-off charge can
never appear in the catalogue.

### Resolution order, and why it fails tight

`billing/catalogue.ts` resolves a workspace's limits as:

1. Unclaimed sandbox? → `SANDBOX_LIMITS`. Nothing below applies.
2. Read the `plans` row for the effective plan name.
3. For each field: take the D1 value if it is present and parses as a number;
   otherwise take `lib/plans.ts`'s value for that tier.
4. Unknown or unreadable plan name → `free`, as `resolvePlan` already does.

Step 3 is the whole point of keeping the floor. amardrive's known gap #3 is a
hardcoded 15 GB fallback that silently grants more than the free tier; the rule
here is the opposite direction, and it is enforced by resolving per-field rather
than per-row so a half-written row cannot widen one dimension.

### Never hardcode the default plan

Stolen verbatim from amardrive, which shipped the bug: resolve the free tier
from `plans.is_default = 1`, never from the literal `'free'`. A partial unique
index enforces exactly one default.

### One live subscription per organization

amardrive needs a unique index because subscriptions are rows. Here
`stripe_subscription_id` is a single column on `organizations`, so the invariant
is structural and needs no index. Recorded so nobody adds a subscriptions table
later without re-establishing it.

### Terraform owns live billing objects

D6 puts real Stripe Products and Prices under `terraform apply`. Three
mitigations, because the failure mode is a billing incident rather than a
rebuild:

- `lifecycle { prevent_destroy = true }` on every product and price.
- A Stripe **Price is immutable**. Changing an amount in `.tf` is a
  *replacement*, so prices use `create_before_destroy` and the old price is
  archived (`active = false`) rather than deleted — existing subscribers keep
  billing the archived price until renewal, which is amardrive's rule.
- The Stripe **webhook endpoint stays out of Terraform.** It already exists and
  its signing secret is already a GitHub Environment secret; adopting it into
  state would rotate `STRIPE_WEBHOOK_SECRET` on first apply and put a live
  signing secret in `agentdisk-tfstate`.

Provider: `stripe/stripe` v0.3.0 — published from `github.com/stripe/terraform-provider-stripe`,
which is Stripe's own GitHub organization. Community tier in the registry, but
it is the first-party one and it carries `stripe_product` and `stripe_price`.
Its artifacts are self-signed, so the lock file pins checksums for all three
platforms rather than letting CI re-resolve from the registry each run.

### A separate root, and a pipeline meant to be deleted

The catalogue is **not** part of `infra/terraform`. It is its own Terraform root
at `infra/stripe-catalogue/`, applied by its own manual workflow, sharing the
state bucket under a different key (`<workspace>/stripe-catalogue.tfstate`).

Three reasons, and the first is what forced it:

- **`ci.yml`'s `terraform-plan` job cannot hold the credential.** That job is
  deliberately unscoped to a GitHub Environment so plans run from feature
  branches on repository-level secrets. `STRIPE_SECRET_KEY` is per-environment,
  because dev must use a test-mode key and prod a live-mode one. Stripe
  resources in the main stack would have left that job permanently red the
  moment the first apply wrote them into state.
- **The blast radius is unlike anything else's.** Separate state means a
  `destroy` of one cannot reach the other.
- **It is temporary.** Once the staff console can edit plans (14 PART 29.6),
  this directory and `.github/workflows/stripe-catalogue.yml` are deleted and
  plans are managed from the admin surface. Nothing else imports from here, so
  deletion is one `git rm -r` plus one file.

The workflow is `workflow_dispatch` only, defaults to `plan` rather than
`apply`, asserts the key's Stripe mode matches the workspace (a live key in the
dev environment is refused), and reads the plan JSON to **refuse any destroy or
replacement** before anything reaches Stripe — an outer guard in front of
`prevent_destroy`, which would otherwise only fire mid-apply.

`STRIPE_SECRET_KEY` needs no new secret; the existing `dev` environment secret
resolves in a job scoped to that environment. **Prod has no `STRIPE_SECRET_KEY`**
— a prod prerequisite, not a dev blocker.

### Counting across an organization

D7 makes four limits account-wide, which means counting rows the caller's
workspace-scoped repository deliberately cannot see. The escape hatch follows
the `transferObject` precedent: a single narrow function per dimension that
takes an organization id, returns an **integer only**, and has no argument
through which a caller could name rows instead of count them.

```
countAgentsInOrg(db, orgId)     → number
countApiKeysInOrg(db, orgId)    → number
countMembersInOrg(db, orgId)    → number
countWorkspacesInOrg(db, orgId) → number
```

There is no `listAgentsInOrg`. If one is ever needed it is a separate decision
with a separate justification.

### Two workspace-creation paths, one limit

`POST /v1/workspaces` serves two callers. Anonymous with a Turnstile token
provisions an unclaimed **sandbox**, which belongs to no organization and is
therefore outside the workspace quota — it is bounded by the rate limiter and
the unclaimed sweep instead. Authenticated, it adds a workspace to the caller's
billing account, and that is the path the quota gates.

## Task list

Dependency-ordered. Each is committed separately.

| # | Task | Touches |
|---|---|---|
| 1 | Standalone `infra/stripe-catalogue/` root: 4 Products + 3 Prices, entitlements in `metadata`, `prevent_destroy` | `infra/stripe-catalogue/` |
| 2 | `stripe-catalogue.yml`: manual plan/apply, Stripe-mode assertion, destroy guard | `.github/workflows/` |
| 3 | Migration `0012`: extend `plans` (agents, members, workspaces, api_keys, max_file_bytes, package_id, is_default), seed 4 rows, one-default index | `apps/api/migrations/` |
| 4 | `lib/plans.ts`: add `basic`, apply the table, unlimited egress/requests/files, add `workspaces` | `apps/api/src/lib/` |
| 5 | `billing/catalogue.ts`: D1-over-floor resolution, per-isolate cache, per-field fallback | new file |
| 6 | `POST /v1/billing/checkout-session`, owner-only | `routes/billing.ts` |
| 7 | Webhook: `checkout.session.completed` + `product.*` → one shared upsert | `routes/stripe-webhook.ts` |
| 8 | `GET` / `POST /v1/staff/plans[/sync]` reconciler, replaying that same upsert | `routes/staff*.ts` |
| 9 | Thread the real `billingStatus` into `assertQuotaAndWarn` — closes `backlog/017` #1 | `middleware/auth.ts` |
| 10 | Four count-before-insert gates: agent identities, API keys, members, workspaces | `routes/agents.ts`, `keys.ts`, `members.ts`, `create-workspace.ts` |
| 11 | Pricing page: 4 columns, feature matrix, egress row, live CTAs → checkout | `lib/pricing.js`, `Marketing.jsx` |
| 12 | Dashboard upgrade path; tests; `CLAUDE.md`; close backlog 017/024 | `SettingsTabs.jsx`, `test/`, docs |

## Testing

- **Unit** — catalogue resolution: a missing row, a half-written row and a row
  with a non-numeric field must each fall to the floor per field, never wider.
- **Unit** — `statusFrom` and the plan-from-price resolution, including an
  unknown price leaving the plan alone.
- **Integration** — a real `POST /v1/files` against a `past_due` workspace must
  be refused. `backlog/017` records that the existing test passes `"past_due"` to
  the helper by hand and therefore proved nothing; this one drives HTTP.
- **Integration** — each of the four count gates refuses at limit + 1 and
  permits at limit, counted across two workspaces in one organization.
- **Webhook** — a forged signature is refused before any field is read; an
  unknown event type is acknowledged, not rejected.
- **Terraform** — `fmt` and `validate` in CI. **No apply is run from this
  session.** The first apply against dev is the user's.

## Risks accepted

1. **D1 refuses writes for any dev workspace over the new Free limits.** Before
   task 10 lands, report exactly which existing dev workspaces are over the line.
2. **Terraform holds live billing objects.** Mitigated above, not eliminated. An
   unguarded `terraform destroy` against this stack remains a billing incident.
3. **The canonical table and D3 disagree** about whether Free gets webhooks. The
   user's decision wins; the pricing page follows the decision, not the table.
