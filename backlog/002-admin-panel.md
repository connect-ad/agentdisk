# 002 · Staff admin panel

**Status:** Built, not yet proven against the live environment
**Priority: HIGH** — below [001](001-billing-module.md), because the plan editor
here is untestable until the Stripe catalogue actually exists.
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

### 1. Run the bootstrap pipeline · *nothing else can be verified first*

`.github/workflows/staff-bootstrap.yml`, `workflow_dispatch`, environment `dev`,
role `super_admin`, for `kernelv5@gmail.com`. **The run log will contain both
authentication factors** — enrol, then delete the run. The workflow prints the
link.

Then delete the workflow itself once a super_admin exists: every further account
comes from the console, which shows the QR once and records who created whom.

### 2. Prove the role matrix against live dev · *32 PART 11, Phase 2 DoD*

Provision three accounts, one per role, and log in as each. The matrix has unit
coverage (`staff-console.test.ts` calls every gated endpoint with a lower role
and expects 403), but the DoD asks for it against the real deployment and that
has not been done.

### 3. Verify the plan editor against real Stripe · *blocked on 001*

The editor pushes to Stripe before writing D1, and every test of that is against
a stub. Until `infra/stripe-catalogue/` has actually been applied, `Edit` on any
plan answers `CONFLICT — this plan is not in Stripe yet`, correctly. Sequence:
apply the catalogue, run **Reconcile all**, then edit a price in dev and confirm
a new Stripe Price is minted and the old one archived.

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

**A pending staff account can sign in.** 32 PART 4 asks for pending accounts to
be unable to authenticate at all. Read literally that produces an account that
can never be used: enrolment is scanning a QR, there is no separate confirm
step, and presenting a valid code is the only proof it was scanned. So
`totp_confirmed_at` is set by the first successful login and *pending* means
created-but-never-signed-in. The distinction PART 4 wants is preserved, because
enrolled-without-TOTP remains impossible.

## One thing softened, narrowly

`CLAUDE.md` records: *the first staff account cannot come from the API, and that
is the design*. `POST /v1/staff/users` still returns 501 and is untouched. The
new `POST /v1/staff/accounts` requires an authenticated super_admin, so it
cannot bootstrap anything — which is what that rule is about. The first account
still comes from the script.

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
