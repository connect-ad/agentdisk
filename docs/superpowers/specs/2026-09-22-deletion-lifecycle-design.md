# Deletion: one lifecycle, and a way back in

**Date:** 22 September 2026
**Status:** design approved, not yet implemented
**Builds on:** `2026-09-22-deferred-file-deletion-design.md`, which specified the
deferral and is partly implemented. This completes it and fixes what it left.

---

## What is already built

The deferred-deletion work landed the mechanism: deleting a workspace destroys
every credential in the request, moves file rows to `pending_deletions`, and
leaves the R2 objects for a sweep seven days later.
`PENDING_DELETION_TTL_MS = 7 days`, the cascade is FK-safe, `job_runs` records
each sweep.

What it did not land is everything a person touches.

## Four defects, in severity order

### 1. Nothing is ever deleted

```ts
const dryRun = options.dryRun ?? true;   // jobs/pending-deletions.ts
dryRun: !pendingDeletionEnabled(env)     // index.ts
```

The sweep defaults to reporting and the flag enabling it is not set in either
environment. File rows accumulate in `pending_deletions` and the R2 objects are
never removed, so storage is paid for indefinitely on files a customer deleted.
The dry-run default is right — it is the same shape as the sandbox sweep, ship
it, read a week of logs, then enable — but nobody enabled it.

### 2. A deleted account can never come back

`users.email` is `NOT NULL UNIQUE`, and the delete does not touch it:

```sql
UPDATE users SET deleted_at = ?, session_revoked_after = ?, updated_at = ?
  WHERE id = ? AND deleted_at IS NULL
```

So the tombstone keeps `alice@example.com`. When Alice returns, Firebase issues
a new UID, the lookup by `firebase_uid` finds nothing, and the insert of a new
`users` row violates the unique index. Signup fails with an error she cannot
act on.

Firebase compounds it. The identity is **disabled**, not deleted, so she can
neither sign in (disabled) nor sign up (`EMAIL_EXISTS`). The address is
permanently unusable.

### 3. Restore outlived its own removal

The deferred-deletion design deleted restore along with the 30-day window.
`staffRestoreUser` is still there (`UPDATE users SET deleted_at = NULL`). It can
now resurrect an account whose bytes a sweep has already destroyed — a restore
that returns an empty shell and reports success.

### 4. The dialog describes the old behaviour

> "All files, agents, and API keys are permanently removed."

Files are not permanently removed; they are queued for seven days. The copy
predates the deferral and was never updated.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Weekly sweep, plus an on-demand trigger in the console** | An hourly sweep for a 7-day window is 168 chances to do nothing. Weekly is enough, and the button covers the cases where waiting is wrong. |
| D2 | **Enable real deletion** in both environments | The flag exists and is off. Nothing about this design works until it is on. |
| D3 | **Scrub the email on deletion** to `deleted-{userId}@agentdisk.invalid` | Frees the real address so the person can return. `.invalid` is reserved by RFC 2606 and can never resolve or receive mail — `bootstrap.ts` already uses this pattern for provisional sandbox owners. The tombstone survives for `audit_events.actor_id`. |
| D4 | **Delete the Firebase identity, do not disable it** | Disabling is correct for a suspension and wrong for a deletion: it leaves the address claimed, so the person can neither sign in nor sign up. |
| D5 | **Delete `staffRestoreUser` and `staffRestoreWorkspace`** | Finishes what the deferred-deletion design started. A restore that cannot restore the bytes is worse than no restore. |
| D6 | **Self-service deletion cancels the subscription; staff deletion still refuses** | The existing rule — *"a human must never implicitly cancel a paid subscription"* — was written for staff deleting somebody else's account. When the owner deletes their own, they **are** that human. The rule survives where it applies and stops blocking where it does not. |
| D7 | **Payment methods detached immediately; invoices retained** | Card tokens are the sensitive part and can be removed with no consequence. Invoices cannot: retention is a legal obligation (typically 7 years), GDPR Art. 17(3)(b) exempts it, and Stripe retains them regardless of what we do to the customer object. Promising their deletion would be a promise we cannot keep. |
| D8 | **Account deletion has a 7-day window; the console can run it now** | Matches the byte window, so there is one retention period in the product rather than two. |

### Re-joining after deletion

The case D3 and D4 exist for. After deletion and a later signup with the same
address:

| | Outcome |
|---|---|
| **Stripe** | Fine, unchanged. A new signup creates a new organization and therefore a new customer; `stripe_customer_id` is per-org and Stripe does not enforce unique customer emails. The old customer is orphaned, which is what invoice retention wants anyway. |
| **Firebase** | Works once D4 lands. A deleted identity frees the address; the returning person gets a new UID. |
| **Our database** | Works once D3 lands. The tombstone holds a `.invalid` address, so the unique index is free. |

The returning account is genuinely new: new org, new workspace, new Stripe
customer, no history. Nothing is recovered, and the UI must not imply it is.

## What the person sees

### Deleting a workspace

The dialog states both halves, because they have different timing:

> **Now, and permanently:** API keys, agents, webhooks, share links, members and
> folder structure. Any agent using this workspace's keys loses access
> immediately.
>
> **In 7 days:** the files themselves. They are already unreachable — this is
> only when the bytes are erased.
>
> **This cannot be undone.** There is no restore. Tags and metadata are removed
> at once, so even within the 7 days we cannot reconstruct what was here.
>
> Need it erased sooner? Email support and we will run it on request.

### Deleting an account

Same shape, plus what happens to billing and identity:

> **Now:** every workspace on this account and everything in them. Your
> subscription is cancelled and your saved payment details are removed.
>
> **In 7 days:** your files' bytes, and your sign-in identity.
>
> **Kept:** invoices, for seven years, because tax law requires it. They hold
> your billing name, address and amounts — nothing else about your account.
>
> You can sign up again later with this email address, but nothing will be
> recovered.

The last line matters: without it, "email permanently freed" reads as "my data
might come back".

## The console section

One new screen, `Deletions`, answering the three questions staff actually have:

- **What is queued** — rows in `pending_deletions`, aggregate bytes and file
  count, oldest entry, and how many are already past their due date.
- **What the last run did** — from `job_runs`: when, triggered by cron or by a
  named staff member, dry-run or real, examined / objects deleted / bytes freed
  / failed.
- **Run it now** — triggers the sweep on demand, recorded as a `job_runs` row
  with the staff actor, exactly as the cron's is.

`job_runs` already carries every field this needs and is currently written by
the job and read by nothing.

A second section covers account deletions in their 7-day window: who, when they
requested it, when it falls due, and the same run-now control.

## Architecture

### One deletion path

```
user deletes account                 staff deletes account
  │                                    │
  │ cancel subscription (D6)           │ refuse if subscription live (D6)
  │ detach payment methods (D7)        │
  ├────────────────┬───────────────────┘
                   ▼
    per workspace: deleteWorkspaceCascade(defer: true)
      credentials + metadata destroyed now
      file rows → pending_deletions
                   ▼
    users row: deleted_at, session_revoked_after, email scrubbed (D3)
                   ▼
    queued: Firebase identity deletion (D4), due in 7 days (D8)
                   ▼
    weekly sweep, or the console button (D1)
      R2 objects deleted
      Firebase identity deleted
```

### Where the Firebase deletion is queued

It cannot happen in the request: the identity must stay refusable for the 7-day
window, and `users.deleted_at` is what refuses it. So the deletion is queued
beside the bytes and performed by the same sweep.

This does not weaken anything. `resolveVerifiedUser` already refuses
`deleted_at IS NOT NULL` as a first-party check, *before* asking Firebase
anything — which is exactly why deletion cannot depend on a third party's side
effect having succeeded.

### Legal copy

`routes/Legal.jsx` promises a purge "within roughly 30 days". Seven days
satisfies it, so nothing is breached, but it now understates the product and
says nothing about invoice retention. Both change together, and Legal.jsx wins
where it and Settings → Privacy disagree.

## Testing

- **Re-join**, as one integration test: create, delete, sign up again with the
  same address, land in a new empty workspace. This is the test that would have
  caught defects 2 and 4, and neither was caught.
- **The sweep deletes**, with the flag on, and does not, with it off.
- **The window holds**: an entry one hour short of due is left alone; one hour
  past is taken.
- **Self-service cancels the subscription; staff deletion still refuses** while
  one is live (D6) — both directions, since the asymmetry is the decision.
- **The tombstone survives** and an `audit_events.actor_id` still resolves after
  deletion.
- **No restore route exists** — pinned at 404, the way `POST /v1/staff/users`
  was.

## Out of scope

- Export-before-delete. A person who wants their files should download them
  first; building an export pipeline is its own project.
- Deleting Stripe customer objects (D7).
- Any recovery path. Restore is gone deliberately (D5).
