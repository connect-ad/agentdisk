# 001 · Billing module

**Status:** In progress — 7 of 12 tasks shipped
**Priority: TOP.** This is the only item in the backlog.
**Design:** [docs/superpowers/specs/2026-09-17-billing-module-design.md](../docs/superpowers/specs/2026-09-17-billing-module-design.md)
**Branch:** `dev` · rollback tag `pre-billing-module` (c0bbc1c)

> **The previous backlog was removed.** Items 001–031 were deleted on
> 18 September 2026 at the owner's direction, so that this module is the whole
> backlog. They are not lost: every one of them is in git history at the tag
> `pre-billing-module`, and `git show pre-billing-module:backlog/025-authorization-hardening.md`
> reads any of them back. Source comments throughout `apps/` still cite them by
> number (`backlog/017`, `backlog/023`, `backlog/024`), and those citations
> remain accurate against that tag.

---

## Why this exists

AgentDisk priced Pro and Team and could not sell either. The billing surface
was a Stripe client, a signature-verified webhook and a link to Stripe's hosted
portal — which manages a subscription that already exists and cannot create one.
Four things were broken rather than merely missing:

1. **No Checkout anywhere.** `stripe.checkout.sessions.create` appeared nowhere.
2. **The `plans` table was never written.** One query read it; nothing filled it.
   So a paid subscription resolved its price to no plan, and
   `organizations.plan` stayed `free` for somebody being charged.
3. **The past-due write block never fired.** `assertQuotaAndWarn` dropped the
   `billingStatus` argument, and no route set `requirement.demand`.
4. **Nothing counted.** `PLAN_LIMITS.agents`, `.apiKeys` and `.members` were read
   by nothing at all.

## The entitlement table

Authoritative. Replaces every other pricing table in the repository, including
07 PART 19.0.

| | Free | Basic | Pro | Team |
|---|---|---|---|---|
| Price / month | $0 | $9 | $20 | $80 |
| Storage | 1 GB | 5 GB | 50 GB | 500 GB |
| Egress · Requests · File count | unlimited | unlimited | unlimited | unlimited |
| Agent identities | 1 | 5 | 10 | 50 |
| Members | 1 | 2 | 5 | 25 |
| Workspaces | 1 | 3 | 10 | 50 |
| API keys | 2 | 6 | 20 | 100 |
| Max file size | 100 MB | 500 MB | 1 GB | 5 GB |
| Share links · Webhooks · Path-scoped keys | ✅ every plan, ungated |
| Priority support | No | No | Yes | Yes — display only |

Counted **per organization**, not per workspace. Agents, keys, members and
workspaces are all account-wide totals.

## Shipped

| # | Task | Where |
|---|---|---|
| 1 | Stripe catalogue: 4 Products + 3 Prices, entitlements in `metadata`, `prevent_destroy` | `infra/stripe-catalogue/` |
| 2 | Manual pipeline: plan/apply by hand, Stripe-mode assertion, destroy guard | `.github/workflows/stripe-catalogue.yml` |
| 3 | Migration `0012`: entitlement columns, 4 seeded plans, one-default index | `apps/api/migrations/` |
| 4 | Four plans in code; canonical numbers; unlimited egress/requests/files | `apps/api/src/lib/plans.ts` |
| 5 | D1-over-floor resolver, per field, wired into `withAuth` | `apps/api/src/billing/catalogue.ts` |
| 6 | `POST /v1/billing/checkout-session`; `purchasable` on `GET /v1/billing` | `apps/api/src/routes/billing.ts` |
| 7 | Ten Stripe events, and the shared product→plan upsert | `apps/api/src/billing/plan-sync.ts` |

617 API tests pass. Tasks 4, 5 and 7 were mutation-checked: the transposed
plan-table digit, the amardrive fail-wide fallback, and a refund that revokes
access each turn the suite red.

## Remaining

### Task 8 — the catalogue sync · *next*

`GET /v1/staff/plans` and `POST /v1/staff/plans/sync`, replaying the same
`syncProductToPlan` the webhook uses. It is what makes the first `terraform
apply` useful: Terraform creates the product before its price, so
`product.created` lands with a NULL price and the sync is what fills it in.

### Verification against real Stripe · *before tasks 9–12*

Tasks 9–12 all rest on an assumption nothing has tested: that the metadata keys
in `catalogue.tf` round-trip into D1 and produce a working checkout. Everything
so far is unit-tested against stubs and a local SQLite; **nothing has touched
Stripe.** Finding a wrong key name after building two UIs on top of it is the
expensive order to discover it in.

1. Run the catalogue pipeline on `dev` with `plan`, read it, then `apply`.
2. ⚠️ **Subscribe the webhook endpoint to the ten events in the Stripe
   dashboard.** Manual, and **nothing in this repository can assert it** — an
   event we handle but no longer receive looks exactly like one that never
   fired. The list is in the header of `apps/api/src/routes/stripe-webhook.ts`.
3. Run the sync, then drive one checkout with a Stripe test card and confirm
   `organizations.plan` actually moves to `pro`.

### Task 9 — thread the real billing status

Closes gap 3 above. `findWorkspaceById` already joins `organizations` and fails
closed, so this is adding `o.billing_status` to that existing query — no extra
round trip.

**It also fixes a dormant fail-wide.** `findOrgForWorkspace` inner-joins `users`
for `ownerEmail`, and both callers read a missing row as `"active"`. Verified
against the real schema: delete the owner's `users` row and a `past_due`
organization vanishes from that query while still sitting in the table marked
`past_due` — and the absence reads as paid up. It is inert today only because
nothing consults `billingStatus` on a write path. **Task 9 is the change that
makes it load-bearing**, so the fix belongs inside it.

### Task 10 — four count gates · *needs a report first*

`createAgent`, `createKey`, `inviteMember` and the authenticated
`createWorkspace` path all insert with no count check of any kind. Each needs a
narrow count-only cross-organization query, in the style of `transferObject`:
returns an integer, with no argument through which a caller could name rows
instead of count them.

**This is the one task that can refuse requests which succeed today.** Before it
ships, report which existing dev workspaces are over the new limits — an
organization with four agents on Free starts getting refused.

### Task 11 — pricing page

Four columns, the feature matrix, an egress row, and CTAs that reach checkout.
Numbers stay **hardcoded** in `apps/web/src/lib/pricing.js` by decision; the
server sends no pricing table, only `purchasable` plan ids.

### Task 12 — dashboard upgrade path, docs, close-out

Upgrade buttons wired to checkout, `CLAUDE.md` updated, and the pricing numbers
reconciled across the repo.

## Rules this module established

- **`NULL` ≠ `-1` in `plans`.** `NULL` means "the row did not say" and defers to
  the `lib/plans.ts` floor; `-1` means unlimited. Collapsing them would make a
  half-written sync indistinguishable from an infinite allowance — the bug
  amardrive actually ships.
- **Fallbacks are per field, and always to the same tier.** Pro falls back to
  Pro, never to Team (too generous) and never to Free (silently downgrades a
  paying customer over one absent column).
- **A Stripe Price is immutable — in Stripe, not just in Terraform.** Changing
  an amount always means creating a new price and archiving the old. Existing
  subscribers keep billing the archived one until they renew. This survives
  whatever tool owns the catalogue.
- **Never hardcode the default plan id.** Resolve it from `is_default = 1`.
- **A refund is not a lifecycle event.** `charge.refunded` must not move
  entitlements; `customer.subscription.deleted` owns that.
- **Free is the absence of a subscription, not a $0 one.**

## Handover: Terraform → admin panel

**Terraform owns the catalogue, and the admin panel must not edit plans, until
this root is deleted.** There is no way to have two owners: an `apply` after an
admin edit reverts that edit, because making Stripe match the `.tf` is
Terraform's entire job.

Ownership transfers in one step — delete `infra/stripe-catalogue/` **and**
`.github/workflows/stripe-catalogue.yml` together. Removing the resources from
config while keeping the workflow would make Terraform plan a *destroy*;
`prevent_destroy` refuses it, but as a confusing error rather than a clean exit.
A `removed { ... lifecycle { destroy = false } }` block first is the tidy way.

**The admin plan editor is not a prerequisite.** The moment Terraform stops
owning the catalogue, the Stripe dashboard becomes the editing surface — edit a
product's metadata, `product.updated` fires, and the sync mirrors it into D1.
That path is already built and tested.
