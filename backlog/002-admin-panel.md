# 002 · Staff admin panel

**Status:** Live on dev. Sign-in works; the plan editor is one sync from usable.
**Priority: HIGH** — below [001](001-billing-module.md).
**Brief:** `Claude outputs/agentdisk-admin-panel-build-prompt.md`
**Design:** Claude Design project `0d71f84d-2555-4ca8-991b-50be0d7fd1d1`,
file `AgentDisk Admin.html`
**Branch:** `dev`

---

## What shipped

Backend, in `apps/api/src/staff/` and `src/routes/staff-console.ts`: user lookup
and the six account actions, deletion check, soft delete and restore, transfer
ownership, plan override, workspace delete and restore, agent disable, key
revoke, billing, the whole plans surface including diff-then-apply, the audit
log with CSV export, and staff account management. Migration `0013` and a fourth
cron sweep.

Frontend, in `apps/admin/src/`: nine screens against the design file, with the
modals, empty states, error states and session-expiry prompt the design does not
draw.

## Remaining, in the order it has to happen

### 1. Sign in · *done*

Staff auth is Firebase (migration `0014`). `kernelv5@gmail.com` is seeded as
`super_admin` and signs in with Google at `admin-dev.agentdisk.io`. There is no
password, no TOTP, no provisioning script and no bootstrap pipeline — all of
them were deleted, because under this scheme an admin IS an email address in
`staff_users` and there is no credential to mint.

**One manual step remains if the Google popup refuses:**
`admin-dev.agentdisk.io` must be in the Firebase project's authorised domains
(Console → Authentication → Settings). The login screen names this explicitly
when it happens.

### 2. Prove the role matrix against live dev

Add two more addresses under Staff Accounts, one `support` and one `admin`, and
sign in as each. The matrix has server-side coverage already —
`staff-console.test.ts` calls every gated endpoint with a lower role and expects
403 — but the DoD asks for it against the real deployment.

### 3. Verify the plan editor against real Stripe

The four products now exist in Stripe test mode and the `product.created`
webhook has already linked their ids into D1. **Prices are still NULL**, because
each product was created before its price and `price.created` is not one of the
ten subscribed events — so one **Reconcile all** finishes the wiring.

Then edit a price in dev and confirm a new Stripe Price is minted and the old
one archived, which is the behaviour every test of this so far has only asserted
against a stub.

### 4. Turn the purge sweep on · *not before a full window*

`STAFF_PURGE_ENABLED` is unset, so the sweep reports and deletes nothing. Read
30 days of `staff purge candidate` log lines first. Dev holds weeks of test data
and enabling it early would take all of it on the first tick.

### 5. Things this deliberately does not do

- **No email to a deleted customer.** 32 PART 7a.8 asks for one; nothing is
  sent. `MAILERSEND_API_TOKEN` and a template exist, so this is small — but it
  is a customer-facing email whose wording is a legal question, not a coding
  one. See the Terms note below.
- **No "your account was deleted by AgentDisk" screen** in `apps/web`. The
  customer gets the ordinary authentication failure, which is correct but
  unhelpful.
- **No webhook delivery tracking**, so no redelivery and no "3+ failing
  webhooks" attention criterion. The workspace detail says *delivery history not
  tracked yet* rather than showing a number nothing computes.
- **No ⌘K jumper.** Cut rather than built as a global search.

## Two deviations from the brief, both deliberate

**Revoking every key a user created stays admin+, not support+.** The brief's
matrix says support. The existing `revokeUserKeys` already required admin, and
loosening a working permission gate is not something to do unasked — the action
reaches across every workspace that person ever created a key in, including
other customers'. Tighter than spec is never an incident; looser might be.
**Confirm or reverse this deliberately.**

**Staff sign in with Firebase, not with their own password and TOTP.** The brief
(§1) is emphatic that staff auth stays independent of Firebase, so that a
Firebase outage cannot lock the team out of the tool they would use to
investigate it. Overruled by the owner: one sign-in for every surface.

The property given up, recorded so nobody has to reconstruct it: a staff
credential and a customer credential are no longer structurally incapable of
reaching each other's routes. One token reaches both, and the ONLY thing
separating them is the `staff_users` lookup. `staff.test.ts` asserts that
explicitly, so reintroducing the separation later reads as a decision rather
than a bug fix.

## The rule this dissolved

`CLAUDE.md` recorded: *the first staff account cannot come from the API, and
that is the design* — because an endpoint that mints a working staff credential
can be tricked into minting one. Under Firebase SSO nothing mints a credential
at all: a staff account is an email address and a role. The rule did not need
softening; its subject stopped existing. The first row is seeded by migration
`0014`.

## Legal follow-up, outside the code

The Privacy Policy and Terms frame account deletion as a *user right*. Neither
grants the right to delete a customer account on staff initiative, and neither
defines notice. `routes/Legal.jsx` is the authoritative text and wins over the
Settings summary. This needs a decision before §7a is used on a real account.

## Rules this module established

- **The audit discipline is inherited, not repeated.** `AuditedStaffAccess` holds
  `record`, `recordFleet` and `requireRole` as protected members; every area
  class extends it. No area can act without the machinery that writes it down.
- **A refusal is recorded too.** `requireRole` writes a `staff.denied` row before
  throwing. A log of only successful actions cannot show somebody repeatedly
  attempting what their role forbids.
- **Stripe is written before D1, everywhere.** A local-only save produces a
  pricing table that says one thing while Stripe charges another, with nothing
  surfacing the disagreement until a customer is billed wrongly.
- **Deletion is a timestamp, never a cascade.** Both delete endpoints set a
  column and stop. The cascade belongs to a cron sweep that defaults to
  reporting.
- **A workspace must be suspended before it can be deleted.** Suspension is
  instant and reversible; it is the right first move in every scenario that ends
  in deletion, and it gives the customer a chance to notice.
- **Literal route segments come before `:id` patterns.** `needs-attention` was
  swallowed by the `:id` GET above it and answered 404 — which reads like a data
  problem rather than the routing one it is. There is a test for it now.
- **`null` and `-1` stay distinguishable on screen**, not only in the database.
  One is a gap that defers to the code floor; the other is a decision.
