# 9 · Admin Console

`apps/admin`, at `securepanel.agentdisk.io`. Nine screens, one shell, routing
by the History API, its own palette. How its operators are made is in
[6 Auth and Firebase](6%20Auth%20and%20Firebase.md); the plan editor's rules are
in [7 Billing and Stripe](7%20Billing%20and%20Stripe.md).

---

## Its own origin, its own look

The separate hostname survives as a way to tell the two apps apart, not as an
isolation boundary; migration 0014 removed the admin cookie that once made it
one. The console deliberately does not import `design-system/`: looking
different from the customer dashboard is how a support engineer knows which
one they are in. Its tokens in `src/app.css` come from the AgentDisk Admin
design file and must not be reconciled with the dashboard's. It refuses
indexing in every environment and has no Turnstile.

## One role

`support`, `admin` and `super_admin` collapsed to `admin` alone, so
**everybody who can reach the console can do everything in it**: delete a
workspace, edit the plan catalogue, grant console access to a new address.
The only boundary left is being in `admin_users`. `requireRole`, the `RANK`
map and the `admin.denied` audit path are deliberately still in the source and
cannot fire; restoring a tier is adding a member to `ADMIN_ROLES` and a number
to `RANK`. `admin-plans.test.ts` asserts that no `admin.denied` row is ever
written, so the day a tier comes back that test failing is the reminder the
denial path is live again.

## Audit discipline is inherited

`AuditedAdminAccess` holds `record`, `recordFleet` and `requireRole` as
protected members and every admin area class extends it, so no area can act
without the machinery that writes it down. A refusal is recorded too. The
class was split out when the console grew six areas, because a
thousand-line class is one nobody re-reads to check the audit methods are still
unconditional.

Every console action writes an `admin_actions` row under the operator's
address. A user row is scrubbed, never removed, because it is what an audit
row's actor id resolves to.

## Deletion sets a timestamp and stops

Both delete endpoints are soft with a 30-day window. The cascade belongs to
`purgeAdminDeleted`, which defaults to reporting and needs
`ADMIN_PURGE_ENABLED = "true"` to delete anything. A workspace must already
be suspended before it can be deleted: suspension is instant and reversible,
and it gives the customer a chance to notice.

## Routing and rendering

- **Literal route segments are matched before `:id` patterns.**
  `workspaces/needs-attention`, `plans/stripe-diff` and
  `plans/sync-from-stripe` were each swallowed by the `:id` route above them
  and answered 404, which reads like a data problem. `admin-console.test.ts`
  pins all three.
- **The console renders nothing it cannot source.** No regions, no card brand
  or last four (we are outside PCI scope), no overage row (pricing is
  hard-capped), no per-workspace MRR (billing is org-scoped), and webhook
  delivery history says *not tracked yet* because nothing records attempts.
- The role gate is checked twice and only the server's counts: the console
  hides what a role cannot do, and every admin method re-checks.
- `workspaces/needs-attention` flags against the account-level allowance,
  since the quota moved there.

## Email from the console

Status, a test send to the operator's own address, and a compose screen
restricted to `@agentdisk.io` senders. Every send writes a fleet row with
sender, recipients, subject and attachment names, never the body. Details in
[2 Email](2%20Email.md).

## Four capabilities with no screen

Agent disable, single-key revoke, transfer-ownership and blast-radius exist as
API methods and have no UI. They are reachable with a token and a curl.
