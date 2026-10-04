# 7 · Billing and Stripe

Plans, prices, checkout, the webhook, the grace ladder, and the live Stripe
setup. The console's plan editor is here too, because it is the catalogue's
only writer.

---

## The live setup, as built on 28–30 September 2026

The Stripe account is shared with another product line, so the sandbox holds
other products too. Live mode holds exactly the four AgentDisk products,
promoted from the sandbox with their metadata and prices, and:

- One webhook, `AgentDisk prod`, at `https://api.agentdisk.io/v1/webhooks/stripe`,
  API version `2023-10-16` (the version dev's endpoint uses and the handler
  is tested against), subscribed to the ten events the handler switches on:
  `customer.subscription.created/updated/deleted`,
  `checkout.session.completed`, `product.created/updated/deleted`,
  `charge.refunded`, `invoice.payment_failed`, `invoice.payment_succeeded`.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` on the prod GitHub
  environment. The deploy needs both or neither.
- The plan sync run from the console on 30 September, which linked the four
  `plans` rows to their live product and price IDs. Until it ran, nothing
  could be bought.

The business name and statement descriptor are Stripe dashboard settings, not
code. Kernelv5 Inc. is the legal name and it is what a card statement shows.

## The catalogue

`plans` holds four rows, `free`, `basic`, `pro`, `team`, each with two prices:
`stripe_price_id` is monthly and `stripe_yearly_price_id` the other. The
client names our plan id plus an interval, never a Stripe price. Yearly is 15%
off twelve months, rounded **down** to the dollar so "save 15%" is never an
over-claim: $91, $204, $816.

- **A product is ours only if its `package_id` starts with `agentdisk-`.**
  Presence in the account is not ownership, and `plan_id` cannot claim a
  product that failed the prefix test.
- **Each product needs two active recurring prices, monthly and yearly, with
  interval count 1.** The sync ignores one-time prices and any other cadence.
  A recurring price in `mode: "payment"` or a one-time price in
  `mode: "subscription"` is refused by Stripe, and this repository had the
  pair inverted for two days with the suite green.
- **The catalogue is changed by a person in the admin console and by nothing
  else.** No cron, no deploy step: an unattended reconcile is a zero-click
  pull that rewrites entitlements with no audit row. The `product.*` webhook
  stays because it records a change somebody made in Stripe.
- **Pulling from Stripe is always a diff the operator confirms field by
  field.** `id`, `package_id` and `stripe_product_id` are identity and never
  synced. A one-click pull can bill real customers the wrong amount.
- **A console plan edit writes Stripe first and D1 second.** If the push
  throws, the local row is untouched. `metadataForPlan` lives beside the
  decoder it must round-trip with, or the two drift.
- Entitlement metadata reads absent or unparseable as `null` (defer to the
  `lib/plans.ts` floor), `unlimited` as `-1`, a number as itself. A typo must
  fall to the floor, never to zero. `null` and `-1` stay distinguishable on
  every screen.
- The catalogue is read once per isolate per minute; after an admin change
  some isolates enforce the old numbers for up to a minute.

## Checkout

`checkoutSessionParams` in `routes/billing.ts` builds the Checkout Session as
a value and `test/checkout-params.test.ts` asserts it, because every test in
`checkout.test.ts` is a refusal that returns before the outbound call and two
defects shipped through that gap, each making every purchase fail with the
suite green. **Stripe still has to accept the combination**, which only a live
session proves.

- `automatic_tax` with an existing customer requires
  `customer_update: { address: "auto" }`, and `ensureCustomer` creates a
  customer before every session, so there is no path where it is optional.
- Customers redeem promotion codes on Stripe's page via
  `allow_promotion_codes`. Validating a code on our side would mean passing
  `discounts` instead, which Stripe refuses alongside it. Discounts live in
  Stripe; there is no promo table, because Stripe counts redemptions
  atomically at the moment a payment clears. The console creates a Coupon then
  a Promotion Code and deactivates rather than deletes. `max_redemptions`
  absent means unlimited, `1` means single use, and the form says which in
  words.

## Subscriptions

- **Auto-renew, monthly or yearly.** Owner's decision, 25 September 2026,
  reversing a two-day experiment with manual renewal.
- **Stripe owns the period; `organizations.current_period_end` is a mirror.**
  Only `stripe-webhook.ts` may write it, plus the console's comp override.
  `customer.subscription.created/updated` settle everything an account is
  entitled to; `checkout.session.completed` binds the subscription id alone,
  so one code path settles entitlements.
- **Cancellation is ours.** `POST /v1/billing/cancel` sets
  `cancel_at_period_end`, never an immediate cancellation, and `resume` takes
  it back. `organizations.cancel_at_period_end` is the only thing that
  distinguishes "Renews 14 October" from "Ends 14 October". The portal survives
  for the card and invoice history.
- **Upgrades are immediate and prorated; downgrades wait for the period
  end**, because dropping a 500 GB account to 50 GB the instant they press the
  button puts them 450 GB over quota. Both directions compare effective
  monthly cost (`yearly / 12`). A downgrade builds a Subscription Schedule and
  D1 stays on the current plan until the webhook says Stripe crossed the
  boundary.
- **Closing an account cancels every non-ended subscription**, not only
  `active`; a `past_due` one bills again the moment the card works. A Stripe
  failure refuses the whole closure with 409 and destroys nothing.

## The grace ladder

- **The grace is ours, counted from `organizations.past_due_since`**, never
  inherited from Stripe's retry schedule, which lives where nothing here can
  read it. The scheduling pass requires the full `RENEWAL_GRACE_MS` to have
  elapsed on our side whatever Stripe does. Anchored on `past_due_since`
  rather than the period end because under auto-renewal a period end is a
  non-event.
- **Both halves are belt and braces.** The webhook moves an account to
  `expired` when Stripe gives up; the job reaches the same state from our own
  clock. Either alone is a single point of failure for the state that decides
  whether data is deleted.
- **A successful payment clears `purge_after`.** Somebody whose card clears
  on day ten must not be deleted by a sweep that stamped them on day seven.
  The one assertion in `billing.test.ts` worth protecting above the others.
- Expiry leaves `organizations.plan` on the paid tier; dropping to Free's 1 GB
  would put an account over quota during the window we are asking it to fix
  its card. The ladder defaults to reporting (`BILLING_EXPIRY_ENABLED`).
- **State changes and lifecycle emails are separate passes.** A state pass
  selects on state and always succeeds; a notification pass selects on state
  and the absence of a `notifications_sent` row, and the UNIQUE index is the
  send-once guard, not an `if`. The row is claimed after a successful send.
- `assertBillingAllowsWrite` is on every write path; `past_due` and
  `expired` each carry their own message.

## Count gates (4 Oct 2026)

`PLAN_LIMITS.workspaces`, `.agents`, `.apiKeys` and `.members` are enforced
on their create paths, shaped like the share-link gate: count the live rows,
compare, refuse with **403 FORBIDDEN** and `details: { limit, used, allowed }`.
403 rather than 429 because a plan ceiling does not clear with time.

- **Account-wide.** `db/org-counts.ts` is the one module that reads across
  every workspace on the bill, and it reads nothing but counts. It is bound
  to the organization in the middleware as `ctx.orgCounts`; the
  user-authenticated `POST /v1/workspaces` builds its own from the org row
  and resolves limits through `limitsForPlan`, the same catalogue the
  middleware uses.
- **Live rows, not counters.** Deleting a workspace or an agent, revoking a
  key or removing a member frees the slot on the next request. Disabled
  agents and disabled keys still count: they keep their slot until deleted.
- **The owner is not a member.** Their org-wide row comes with paying for
  the account. The member allowance is how many other people may be invited,
  counted once per person however many workspaces they are invited to.
- **Validation first.** The gate runs after the body is validated and after
  duplicate checks, so a malformed request hears about its shape and "already
  a member" wins over "plan is full".
- **Sandboxes** are held to `SANDBOX_LIMITS` (one agent, one key) with a
  message that says to claim the workspace rather than to upgrade.
- The gate is a pricing boundary, not a security one: two creates racing
  past the same ceiling can both land, and that is accepted.

Tests: `test/count-gates.test.ts`. Fixtures that mint freely put the test
organization on Team with `setOrgPlan` from `test/helpers.ts`.

## What is not built

Customer-side promo validation (see above), invoice PDFs of our own, and
multi-currency (USD only, every money column in minor units). The dashboard
does not yet show "used / allowed" for the four counted limits; it surfaces
the refusal message from the API as the form error.
