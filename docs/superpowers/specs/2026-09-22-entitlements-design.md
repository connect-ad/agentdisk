# Entitlements: one enforcement path, one scope

**Date:** 22 September 2026
**Status:** design approved, not yet implemented
**Supersedes:** decision D2 of `2026-09-17-billing-module-design.md`

---

## The problem

Ten limits are declared in `PlanLimits`. Three are enforced.

| Limit | Intended scope | Enforced today |
|---|---|---|
| `storageBytes` | account | yes |
| `fileCount` | account | yes, but `UNLIMITED` on every plan |
| `maxFileBytes` | per file | yes |
| `egressBytesPerPeriod` | workspace / period | yes, but `UNLIMITED` on every paid plan |
| `requestsPerPeriod` | workspace / period | comparison exists; **counter never increments** |
| `agents` | account | **no** |
| `apiKeys` | account | **no** |
| `members` | account | **no** |
| `workspaces` | account | **no** |
| `shareLinks` | workspace today, **account** after D4 | **no** — and the dashboard gates a button on it |

The values flow through the whole catalogue: `lib/plans.ts` floor, the `plans`
table, Stripe sync, the console plan editor, `whoami`. Everything except the
comparison that would refuse a request.

`shareLinks` is the worst of the five. `whoami` reports used/max and the
dashboard disables its create button accordingly, so the UI teaches a rule the
server does not keep — and an API caller bypasses it silently. A screen that
contradicts the thing protecting you is worse than no screen.

Two further defects in the same system:

- **`past_due` cannot block a write.** `assertBillingAllowsWrite` is only
  reached when `requirement.demand` declares bytes or files, and no route in
  the API declares `demand`. The billing status is therefore always read as
  `"active"`.
- **`requests_period` is never incremented.** It is read by the quota check and
  reported by `whoami` as a fact. It is permanently zero.

## What it costs us to be wrong

R2 pricing, verified 22 Sept 2026:

| | rate |
|---|---|
| Storage | $0.015 / GB-month |
| Class A (writes) | $4.50 / million |
| Class B (reads) | $0.36 / million |
| **Egress** | **$0** |

Egress is free. Operations are not. The product currently meters the free
dimension and ignores the billed one.

The exposure is **file count, not bandwidth**. At an average file size of 1 MB
the Team plan costs ~$9 against $80 of revenue. At 10 KB average it costs ~$412,
and most of that is ingest — before anyone downloads anything.
`fileCount: UNLIMITED` on every plan, including Free, is the hole.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Egress is capped at 10× storage per plan**, not unlimited | Reverses D2 of the billing design. Egress costs $0, so the cap is not a cost control — it is a shape customers understand and a defensible headline against a competitor capping at 5×. |
| D2 | **`fileCount` gets real values per plan** | The actual cost exposure. Bounds the tiny-file attack that `maxFileBytes` cannot. |
| D3 | **Requests are counted, never capped** | Real cost basis, but metering costs a D1 write on every request. Not worth paying pre-launch. The counter exists so the decision to cap can later be made from data. |
| D4 | **Every billable dimension is account-scoped** | Billing, storage and the plan override are already account-scoped (0017, 0018). Egress and requests are the last workspace-period holdouts; leaving them split means two answers to "what is my usage". |
| D5 | **Over-limit blocks the next create; never breaks what exists** | Matches storage, which refuses the next upload rather than deleting files. Matches the codebase's standing preference — the sandbox sweep and staff purge both default to reporting. A downgrade or a console plan edit puts accounts over limit routinely; that must never disable a running agent. |
| D6 | **One enforcement function. No route hand-rolls a count.** | Five limits enforced in five routes drift. This is the `assertQuotaAndWarn` lesson from `backlog/017` applied to the remaining dimensions. |
| D7 | **Team `maxFileBytes` is 4.9 GB, not 5 GB. Multipart stays out of scope.** | R2's single-part ceiling is 4.995 GiB and multipart is not built. 5 GB would be a published limit no upload path can reach. |

### The plan table

| | Free | Basic | Pro | Team |
|---|---|---|---|---|
| Price / month | $0 | $9 | $20 | $80 |
| `storageBytes` | 1 GB | 5 GB | 50 GB | 500 GB |
| `egressBytesPerPeriod` | 10 GB | 50 GB | 500 GB | 5 TB |
| `fileCount` | 10,000 | 100,000 | 1,000,000 | 10,000,000 |
| `maxFileBytes` | 100 MB | 500 MB | 1 GB | 4.9 GB |
| `agents` | 1 | 5 | 10 | 50 |
| `apiKeys` | 2 | 6 | 20 | 100 |
| `members` | 1 | 2 | 5 | 25 |
| `workspaces` | 1 | 3 | 10 | 50 |
| `shareLinks` | 0 | 10 | 100 | unlimited |
| `requestsPerPeriod` | counted, never capped |

Every number in this table is an **account** total, not a per-workspace one
(D4). Pro's 100 share links are 100 across all ten of its workspaces, not 100
each. This is the one place the change makes a plan *tighter* than a reader of
the old table would expect, so it belongs on the pricing page in those words.

**`maxFileBytes` above 100 MB is presigned-only.** A Cloudflare Worker's request
body is capped by the *account* plan — 100 MB on Free and Pro — and the inline
upload path base64-encodes, inflating by a third. So Basic, Pro and Team file
sizes are reachable only through the presigned path, which is disabled when the
R2 credential pair is unset. That dependency must be stated at the point the
limit is declared, or an unset credential silently caps every plan at 100 MB.

## Architecture

### One function

```
assertEntitlement(ctx, demand) -> throws ApiError("LIMIT_EXCEEDED")
```

Replaces `assertQuotaAndWarn` and absorbs the count-based dimensions. Takes the
same shape as today's `QuotaDemand`, extended:

```ts
interface Demand {
  bytes?: number;        // storage
  files?: number;        // file count
  egressBytes?: number;  // egress
  agents?: number;       // NEW
  apiKeys?: number;      // NEW
  members?: number;      // NEW
  workspaces?: number;   // NEW
  shareLinks?: number;   // NEW
}
```

Every creation route declares its demand and calls this. Nothing counts rows on
its own. As with `assertQuotaAndWarn`, the block and the sandbox warning remain
one call, so there is no way to perform one without the other.

### Where the counts come from

Storage and files already have denormalised counters on `organizations`
(migration 0017), maintained incrementally and reconciled hourly. The five new
dimensions do **not** get counters. They are `COUNT(*)` at the moment of
creation, because:

- they change rarely — an account creates an agent occasionally, not per request
- they are small — bounded by the limit being checked
- a denormalised counter for a number that moves twice a month is drift waiting
  to happen, and the reconciler would be doing more work than the count

Egress keeps its counter, moved to the account (see below). Requests gain one.

### Scope collapse

`workspaces.egress_bytes_period`, `workspaces.requests_period` and
`workspaces.period_reset_at` move to `organizations`. After this, every billable
number lives on the account and `workspaces` carries only its own descriptive
counters (storage, files) for display.

The period reset keeps its existing semantics, including the rule that a counter
past its reset moment reads as zero — otherwise an account that hit its cap
stays locked out until the reconciliation job happens to run, which is a bug
that only appears on the first of the month.

### Requests counter

Incremented once per authenticated request, in `withAuth`, off the response path
via `waitUntil` — the same treatment `last_used_at` gets, and for the same
reason: a D1 write must not be in the caller's latency. Never compared against
anything (D3).

### Usage history

New table `usage_daily`:

```
org_id, day (YYYY-MM-DD), storage_bytes, file_count, egress_bytes, requests
PRIMARY KEY (org_id, day)
```

Written by a new daily sweep beside the existing cron sweeps. 30-day retention,
trimmed by the same job. This is the only genuinely new machinery in the design;
everything else is wiring dimensions that already exist.

The dashboard's Usage page replaces four meters with charts. Today those meters
render a progress bar against `UNLIMITED`, which sits at 0% forever, and the
requests row reports a counter that never moves. The History panel is an
explicit "not built yet" placeholder that this fills.

### `past_due`

Routes declare `demand`, so the middleware can read the billing row and refuse a
write on an unpaid account. Reads continue — locking somebody out of their own
files to chase a payment turns a billing problem into a support crisis, and
reads are the cheap half.

## Removals

Listed explicitly; nothing is deleted that is not named here.

| Removed | Why |
|---|---|
| `workspaces.egress_bytes_period`, `.requests_period`, `.period_reset_at` | Moved to `organizations` (D4) |
| `QuotaDimension` members that nothing throws | The vocabulary was written for limits never wired; after this every member is reachable, and any that is not is deleted |
| The dashboard's client-only `shareLinks` gate | Replaced by server enforcement; the button may still disable, but it is no longer the only check |
| `SANDBOX_LIMITS.egressBytesPerPeriod` / `.requestsPerPeriod` special-casing | A sandbox is one workspace in its own org, so the account-scoped path covers it |

## Testing

- **Unit** per dimension: at the limit, one over, one under, and the message
  naming the account rather than the workspace.
- **The property that matters**, as an integration test: two workspaces on one
  account share one allowance for *every* dimension — the same assertion that
  caught the storage loophole, extended to the other nine.
- **Downgrade**: an account already over a limit can still read, still delete,
  and is refused only on create (D5).
- **`past_due`**: a write is refused, a read is not.
- **Mutation check** on the five newly-enforced limits, matching the discipline
  applied to the storage core — a deliberate break must turn the suite red.

## Sequencing

The plan may land this in stages; nothing here requires one commit. A safe
order, each independently shippable and verifiable:

1. Plan values (D1, D2, D7) — data only, no behaviour change while the
   comparisons are still absent.
2. `assertEntitlement` plus the five count dimensions (D6, D5).
3. Scope collapse for egress and requests (D4), and the requests counter (D3).
4. `usage_daily`, the sweep, and the dashboard charts.
5. `past_due` (routes declaring `demand`).
6. Removals.

Step 1 before step 2 matters: shipping real limit values while nothing enforces
them is inert, whereas shipping enforcement against the current `UNLIMITED`
values would be a no-op that looks finished.

## Out of scope

- Multipart upload (D7). Needed only for files above 4.995 GiB.
- Capping requests (D3). The counter makes it a later data decision.
- Per-dimension overage billing. Pricing is hard-capped by design.
- Image/asset transforms — a competitor feature this product does not have.
