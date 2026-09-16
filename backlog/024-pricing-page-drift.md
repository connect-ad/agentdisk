# 024 · The pricing page contradicts the enforced limits

**Status:** Open — found by the 8 Sept 2026 audit ([summary.md](../summary.md) §4.1)

`routes/Marketing.jsx:202` hardcodes a `PLANS` array. `apps/api/src/lib/plans.ts`
is what the API enforces. They agree on nothing.

| | Marketing says | Code enforces |
|---|---|---|
| Free — storage / files / requests / agents | 1 GB · 1,000 · 10,000 · 1 | **2 GB · 5,000 · 100,000 · 3** |
| Pro — storage / files / requests / agents | 10 GB · 10,000 · 100,000 · "Unlimited" | **50 GB · 100,000 · 2,000,000 · 20** |
| Team — storage / files / requests | 100 GB · 100,000 · 1M | **500 GB · 1,000,000 · 20,000,000** |

Most of these under-sell the product, which is merely embarrassing. Two are the
dangerous direction: **"Unlimited agents" on Pro against a hard limit of 20**, and
Team's "SSO (coming soon)" and "Audit export", neither of which has any
implementation.

The FAQ on the same page adds two more:

- "Deleted files stop counting once they leave the **30-day** trash window" — the
  grace period is 24 hours (`files.ts:40`), and quota is released **immediately**
  on delete (`files.ts:621`), not after any window.
- "Downgrading below your current usage keeps your data readable but blocks new
  writes" — the write block is not enforced; see
  [017](017-enforce-declared-limits.md).

The annual-billing toggle (`Marketing.jsx:240`) sets state that is never read, so
prices do not change, beside a "2 months free" badge.

**There is also no purchase path.** All three plan CTAs link to `/signup`
regardless of plan, and the billing API offers only
`billingPortal.sessions.create` — no Stripe Checkout session exists anywhere. A
customer cannot subscribe to Pro or Team through this product at all. That is the
customer-facing half of the "editable plans and pricing" gap already recorded in
[docs/STATUS.md](../docs/STATUS.md), which names only the staff console side.

**To close:** derive the plan table from one source rather than two. `plans.ts`
already is that source and the API is the thing that will actually refuse a
request, so it should win — the same precedence rule `CLAUDE.md` applies to the
spec.
