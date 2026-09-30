# Account lifecycle — the complete design

**Owner's frame (24 Sept 2026):** advance payment, no auto-renewal, no refunds.
**Start:** a stranger signs up. **End:** their data is gone and nothing about
them blocks anything.

> ## Superseded in one respect, 25 September 2026
>
> **Auto-renewal came back**, and yearly billing arrived with it. Subscriptions
> bill themselves; Stripe owns dunning and retries. Everything below about the
> *shape* of the lifecycle still holds — the ten stages, the two rules, the
> named exits — and one thing does not: **the trigger for `lapse` is no longer
> "the period ran out with nobody buying another", it is "the renewal charge
> failed".**
>
> Concretely, wherever this document says a stage is anchored on
> `current_period_end`, the anchor is now `past_due_since`. Under auto-renewal a
> period end is a non-event: Stripe charges and mirrors in a new one, so an
> account sitting past its period end is almost always one that renewed
> perfectly. Read `lib/renewal.ts` and migration `0029_auto_renewal_yearly.sql`
> for what replaced it.
>
> The document is kept rather than rewritten because the reasoning that produced
> it — the ten stages, and the finding that three of them did not exist — is
> what made the ending get built at all, and that ending survived the reversal
> untouched.

## Why this document exists

The manual-renewal work shipped on 23 September built a complete *beginning* and
no *ending*. It defined acquisition, conversion, lapse, grace and suspension, and
stopped — while shipping an email that promised a deletion nothing performed.

That was not a missing feature. The standard SaaS billing lifecycle is one of the
best-documented patterns there is:

```
acquire → convert → renew → lapse → grace → suspend → terminate → retain → purge → shell
```

Ten stages. Seven were built. The three that were not — **retain, purge,
shell** — are where every defect found in the 24 September review lives. This
document is the whole ten, so the next change has a shape to check itself
against rather than a list of rules to remember.

## The two rules this design is held to

1. **Every state has a named exit.** If it cannot be said what ends a state, the
   state is not designed. `plan_override` failed this for months and read as
   intentional.
2. **Every grant of entitlement carries its end date in the function signature.**
   A clockless grant must not compile. Remembering is not a control — the
   codebase already uses this trick for `assertWithinQuota`, which takes
   `WorkspaceRow & AccountUsage` so a caller holding the wrong thing cannot call
   it at all.

There is a third rule, learned from what broke:

3. **Check against the one good state, never the list of bad ones.** Adding
   `expired` broke every site written `status !== 'canceled'` and broke none
   written `status !== 'active'`.

---

## The ten stages

### 1 · Acquire

Two entrances.

**A person signs up.** Firebase authenticates; `db/bootstrap.ts` writes a user,
an organization and a first workspace in one transaction.

> **Change:** the org's plan is resolved from `is_default = 1` via
> `defaultPlanId()`, not written as the literal `'free'`. Renaming the entry tier
> must not leave signup writing a plan the catalogue no longer describes.

**An agent provisions itself.** `POST /v1/workspaces` with a Turnstile token and
no credential, returning a sandbox workspace, a one-time key and a claim link.
Held to `SANDBOX_LIMITS`; swept after 7 days if unclaimed.

**Exit:** into stage 2, or stays in stage 2 forever.

### 2 · Free life

`current_period_end IS NULL`. No clock, no email, no expiry. Quota refuses writes
past 1 GB; nothing else ever refuses anything.

**This is the only state with no exit, and that is correct.** Free is the
product, not a trial. NULL here means *never bought anything* and must never be
read as expired.

**Exit:** purchase, or self-deletion, or never.

### 3 · Convert

Owner picks a plan on Manage Subscription; Stripe Checkout takes the money on its
own domain. `checkout.session.completed` writes plan, `current_period_end`,
`billing_status = 'active'`, and clears `purge_after`.

Refusals, all of which must name a reason a person can act on: not the owner, not
a person, the free plan, an unknown plan, a plan with no synced price, a period
still comfortably live.

> **Change (E):** a customer may renew **a plan they already hold** even when
> `is_public = 0`. Retiring a plan must not be a destructive act against its
> existing customers — under the old subscription model Stripe kept billing the
> archived price and nobody was stranded; under manual renewal the `is_public`
> gate turns retirement into a forced march to deletion.

> **Change (C):** `checkout.session.async_payment_succeeded` grants the plan and
> `..._failed` logs. Advance payment means service follows cleared money — not
> that money clears and service never arrives.

### 4 · Renew — manual only

Nothing auto-renews. The window opens at **T−7** and stays open once the period
has ended. Buying inside the window extends from `current_period_end`, never from
now, so renewing early never discards days already paid for.

`renewalOpen` is computed server-side and sent to the client, so a skewed browser
cannot offer a button the server will refuse.

### 5 · Lapse — T+0

`billing_status = 'expired'`. Writes blocked, reads and downloads untouched.
**`organizations.plan` deliberately stays on the paid tier** — dropping a 40 GB
account to Free's 1 GB puts it instantly over quota through no act of its own,
during the exact window it is being asked to renew in.

> **Change (I):** the lock renders in the app shell, not only on the billing
> page. Today `writesBlocked` has exactly one call site, so the first anyone
> learns of it is a failed upload.

> **Change (L):** dates render `timeZone: 'UTC'` everywhere. The email pinned UTC
> and the dashboard used the browser's, so a customer east of ~UTC+4 saw a
> deletion deadline one day out from the one they were emailed.

### 6 · Grace — T+0 to T+7

Seven days. Everything stored stays readable and downloadable; nothing is
removed. Renewing restores the account exactly and **clears `purge_after`** — the
single most important write in the feature.

### 7 · Terminate — T+7

`purge_after` is stamped and the third email is sent.

> **Change:** `purge_after = stamp + 7 days`, not the already-past
> `periodEnd + 7 days`. As built, the stamp was in the past the moment it was
> written, so an email saying *"scheduled for deletion"* would have been followed
> by deletion within the hour. Seven days matches the window Privacy c.12 already
> publishes for workspace and account deletion — no new number invented.

### 8 · Retain — T+7 to T+14

The account is terminated but its bytes are intact and renewal still recovers
everything. This stage did not exist; it is the difference between *scheduled*
and *deleted*.

**Total: 21 days from last payment to data loss, across three emails.**

### 9 · Purge — T+14

> **New (A).** `organizations.purge_after` is written by
> `jobs/billing-renewal.ts` and, as shipped, **read by nothing that acts** —
> every consumer in the codebase reads `users.purge_after`. A pass in
> `jobs/pending-deletions.ts` walks due organizations, removes each workspace via
> `deleteWorkspaceCascade` (objects before rows, because the rows are the only
> record of which objects exist), then the org rows.

**The `users` row is scrubbed, never removed** — it is what an `audit_events`
actor id resolves to, and it is what lets the person sign in and reach stage 10.

Dry-run by default behind its own flag, matching `SANDBOX_EXPIRY_ENABLED` and
`ADMIN_PURGE_ENABLED`.

**Three routes must be able to end a lapsed account, and as shipped all three
failed in the same direction:**

> **New (N):** `admin/users-access.ts` blocks deleting a user whose org billing
> is not `canceled`. An expired account is not `canceled`, so the console refuses
> with *"Cancel it in Stripe before deleting the account"* — **and there is no
> subscription in Stripe to cancel.** The instruction cannot be followed.

> **New (O):** `jobs/admin-purge.ts` computes
> `liveBilling = customerId !== null && status !== 'canceled'`, so an expired
> account is treated as a **paying customer** and skipped forever.

Both are fixed by one shared predicate, applying rule 3:

```ts
isPayingNow(org) === org.billing_status === "active" && org.current_period_end > now
```

### 10 · Shell

> **New (K).** The person can still sign in; they have no workspaces. Today the
> only zero-workspace empty state in the product lives in the claim flow and
> explains nothing.

The screen states what happened with both dates — *"removed on 28 October, 14
days after the Pro plan ended on 14 October"* — and offers the one action left:
buy a plan and start again.

---

## The operator's parallel lifecycle

Every stage above describes the customer. The operator acts on the same account
and had no lifecycle at all.

> **Change (H):** `setPlanOverride` writes `plan_override` **and**
> `current_period_end`, default **30 days**, operator may set another date. As
> shipped it wrote one column and no clock, so a support quota bump became a
> permanent unpaid grant that the ladder skipped forever — it was not a
> subscription missing a period, it was a grant that never had one. With a period
> it runs the identical ladder as a purchase: remind, lock, schedule, purge.

> **Change (D):** the console can see stage 5 onward — `expired` tones as `warn`
> not neutral grey, gains a filter and a summary tile, and a queue lists every
> organization with `purge_after` set. As shipped, an operator asked *"who is
> about to lose their data?"* could not answer.

> **Change (M):** `findOrgForWorkspace` uses `LEFT JOIN users`, and a missing
> owner row **refuses** the write. The inner join plus `?? "active"` in
> `middleware/auth.ts` meant an orphaned owner row silently disabled the write
> lock. No trigger exists today — `deleteProvisionalOwner` is properly guarded —
> but it is a fail-open default in a file where every other billing read fails
> closed.

## Money, stated once

Advance payment. No refunds. No auto-renewal. Published as **Payment
Instructions & Policy**, which becomes the authoritative text; Terms c.15 and
Privacy c.12 point at it rather than restating it.

> **Change (B + F):** as shipped, neither document disclosed that lapsing
> destroys data. Privacy c.12 said data is retained *"while your account and
> workspace are active"* and Terms c.15 reserved termination only *"for breach of
> these Terms"*. The product was about to do something its published terms did
> not cover.

A **chargeback** is bank-initiated and no policy prevents it; `dispute.created`
is out of scope by decision, and a disputed month therefore stays live.

## Agents

An API key meets stage 5 as `LIMIT_EXCEEDED` with `details.limit === 'billing'`
and `details.status`. The prose is for humans; **the contract is those two
fields**, and it gets documented (J) so retry logic can tell a billing lock from
a storage cap it might actually clear.

## Verification

Each stage needs a test at its boundary — the tick before and the tick after —
plus three that are worth more than the rest:

1. **Renewal clears `purge_after`.** Somebody who pays on day ten must not be
   deleted by a sweep that stamped them on day seven.
2. **An expired account is deletable** by both the console and the purge job.
3. **No organization holds a paid entitlement with a null period.** An invariant
   test, so the day a third grant path appears it fails loudly.
