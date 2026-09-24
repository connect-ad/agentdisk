/**
 * Billing — 14 PART 29.1/29.3.
 *
 * ── No card ever reaches us ─────────────────────────────────────────────────
 * The card is entered on Stripe's own hosted page, on Stripe's domain. This
 * Worker creates the session and receives back a URL, and the only
 * payment-shaped things in D1 are opaque Stripe ids that are useless without
 * our secret key. That is what keeps AgentDisk in PCI DSS SAQ-A — the lightest
 * scope there is — and the rule that preserves it is absolute: never let a card
 * number touch this origin, not even in transit, not even to forward it.
 *
 * ── Subscriptions renew themselves ──────────────────────────────────────────
 * Owner's decision, 25 September 2026, reversing the manual-renewal design of
 * 23 September. Checkout creates a Stripe **Subscription**, Stripe bills it,
 * and Stripe owns dunning and retries. What this product owns is the ladder
 * that runs when collection fails: locked at the failure, deletion scheduled
 * seven days later, purged seven after that. `lib/renewal.ts` holds the clock
 * and `jobs/billing-renewal.ts` walks it.
 *
 * Two prices per plan since migration 0029 — monthly, and yearly at a discount.
 * The client names our plan id and an interval; it never names a Stripe price.
 *
 * ── What this file owes the customer ────────────────────────────────────────
 * An auto-renewing charge carries obligations a one-off payment does not, and
 * three of them are implemented here rather than promised in a policy document:
 * the renewal date and amount are on the billing screen before the charge, the
 * subscription can be cancelled in one request from inside the product, and a
 * cancellation is reversible until the moment it takes effect. Making somebody
 * visit a hosted portal to stop paying is the pattern consumer-protection law
 * was written about.
 */

import { ApiError, forbidden, validationError } from "../lib/errors";
import { stripeClient, type Stripe } from "../billing/stripe";
import {
  attachStripeCustomer,
  findOrgForWorkspace,
  type OrgBilling,
} from "../billing/organizations";
import { loadCatalogue, type Catalogue, type PlanRow } from "../billing/catalogue";
import {
  deletionScheduledAt,
  isBillingInterval,
  yearlyDiscountPercent,
  type BillingInterval,
} from "../lib/renewal";
import type { AuthContext } from "../middleware/auth";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export interface BillingDeps {
  db: D1Database;
  secretKey?: string;
  /** Where Stripe returns the person afterwards. */
  returnUrl: string;
  /** Root of the dashboard, for building checkout's own return URLs. */
  dashboardUrl: string;
}

/** The Stripe price for one plan at one cadence, or null if not sold that way. */
function priceIdFor(plan: PlanRow, interval: BillingInterval): string | null {
  return interval === "year" ? plan.stripe_yearly_price_id : plan.stripe_price_id;
}

/** What one period costs at one cadence. */
function amountFor(plan: PlanRow, interval: BillingInterval): number | null {
  return interval === "year" ? plan.amount_cents_yearly : plan.amount_cents;
}

/**
 * What a plan costs per month, whichever way it is bought.
 *
 * The only honest way to compare a $20 monthly plan with a $204 yearly one, and
 * therefore the thing `changePlan` branches on: without it, every switch from
 * monthly to yearly looks like a 10× upgrade and every switch back looks like a
 * catastrophic downgrade. amardrive compares exactly this, for exactly this
 * reason.
 */
function effectiveMonthlyCents(plan: PlanRow, interval: BillingInterval): number {
  const amount = amountFor(plan, interval);
  if (amount === null) return 0;
  return interval === "year" ? Math.round(amount / 12) : amount;
}

/**
 * Which plans this account could actually buy right now, and at which cadences.
 *
 * The shape changed with migration 0029: a plan is no longer purchasable or not,
 * it is purchasable *monthly*, *yearly*, or both. A plan whose yearly price has
 * not been minted in this environment must not render a yearly button, and the
 * front end cannot know which without being told.
 *
 * Everything else a customer reads — price, storage, agent count — stays
 * hardcoded in the dashboard and on the marketing page, so the server still
 * sends no pricing table. The two amounts below are the exception and they earn
 * it: they are what Stripe will actually charge, and a dashboard quoting a
 * figure the catalogue has since changed is how somebody is surprised by their
 * own invoice.
 */
function purchasablePlans(
  catalogue: Catalogue
): { id: string; monthlyCents: number | null; yearlyCents: number | null; savePercent: number | null }[] {
  return [...catalogue.values()]
    .filter((row) => row.is_public === 1 && row.amount_cents > 0)
    .filter((row) => row.stripe_price_id !== null || row.stripe_yearly_price_id !== null)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((row) => ({
      id: row.id,
      monthlyCents: row.stripe_price_id === null ? null : row.amount_cents,
      yearlyCents: row.stripe_yearly_price_id === null ? null : row.amount_cents_yearly,
      savePercent:
        row.stripe_yearly_price_id === null || row.amount_cents_yearly === null
          ? null
          : yearlyDiscountPercent(row.amount_cents, row.amount_cents_yearly),
    }));
}

/** What the Billing screen renders. Safe for any member to read. */
export async function getBilling(ctx: AuthContext, deps: BillingDeps): Promise<Response> {
  const org = await findOrgForWorkspace(deps.db, ctx.workspaceId);
  if (org === null) throw new ApiError("NOT_FOUND", "No billing account for this workspace.");

  const catalogue = await loadCatalogue(deps.db, ctx.now);
  const current = catalogue.get(org.plan) ?? null;

  return json({
    // Ids and the two amounts, not a plan table. See purchasablePlans.
    purchasable: purchasablePlans(catalogue),
    billing: {
      plan: org.plan,
      status: org.billingStatus,
      /** False until somebody opens the portal or buys something. */
      configured: org.stripeCustomerId !== null,
      subscribed: org.stripeSubscriptionId !== null,
      ownerEmail: org.ownerEmail,
      // Said explicitly rather than left for the UI to infer from the status
      // string, so the rule lives in one place.
      writesBlocked: org.billingStatus !== "active",

      /* ------------------------ the renewal clock ------------------------ */

      /** When the paid period ends. Null for an account that never bought one. */
      periodEndsAt: org.currentPeriodEnd,
      /** 'month' | 'year' | null. */
      interval: org.billingInterval,
      /**
       * Whether `periodEndsAt` is a renewal or an ending. The screen says
       * "Renews 24 October" or "Ends 24 October" from this one field, and
       * nothing else in the response can tell the two apart.
       */
      cancelAtPeriodEnd: org.cancelAtPeriodEnd,
      /**
       * What the next charge will be, in minor units. Quoted from the plan the
       * account is actually on at the cadence it actually bills at, so it
       * matches the invoice rather than the pricing page. Null once cancelling:
       * there is no next charge to name.
       */
      renewalAmountCents:
        org.cancelAtPeriodEnd || current === null || org.billingInterval === null
          ? null
          : amountFor(current, org.billingInterval),
      /** When the current run of failed charges began. Null means not in dunning. */
      pastDueSince: org.pastDueSince,
      /** When the grace ends and data is scheduled for deletion, once failing. */
      graceEndsAt: org.pastDueSince === null ? null : deletionScheduledAt(org.pastDueSince),
      /**
       * Set once a sweep has actually stamped the account. Distinct from
       * `graceEndsAt`, which is only ever a projection: this one means it has
       * happened, and paying is what clears it.
       */
      purgeAfter: org.purgeAfter,
    },
  });
}

/**
 * A one-time URL into Stripe's hosted portal.
 *
 * Owner-only. The portal changes the card and lists invoices, which is authority
 * over the account rather than over this workspace's contents — the same line
 * that separates an admin from an owner everywhere else.
 *
 * Cancellation deliberately does NOT go through here. It has its own endpoint
 * below, because sending somebody to a Stripe-branded page to stop paying is
 * both worse product and the exact friction consumer-protection rules target.
 */
export async function createPortalSession(
  ctx: AuthContext,
  deps: BillingDeps
): Promise<Response> {
  const { org, stripe } = await ownerContext(ctx, deps, "open billing");
  const customerId = await ensureCustomer(stripe, deps.db, org, ctx.now);

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: deps.returnUrl,
  });

  return json({ url: session.url });
}

/**
 * POST /v1/billing/checkout-session — 14 PART 29.1.
 *
 * Owner-only, on the same reasoning as the portal: committing the account to a
 * recurring charge is authority over the billing account, not over one
 * workspace's contents.
 *
 * The client names OUR plan id and an interval, never a Stripe price. That keeps
 * the mapping server-side, where the catalogue already is — a caller who could
 * pass a price id could subscribe the account to any price in the Stripe
 * account, including an archived one nobody is meant to be sold any more.
 */
export async function createCheckoutSession(
  ctx: AuthContext,
  request: Request,
  deps: BillingDeps
): Promise<Response> {
  const { org, stripe } = await ownerContext(ctx, deps, "start a subscription");
  const { plan: requested, interval } = await readPlanBody(request);

  // A live subscription is the thing actually billing the customer. Selling a
  // second one on top would charge twice for the same weeks — the guard
  // amardrive names ALREADY_SUBSCRIBED, enforced here regardless of what the
  // client does, because a stale tab is enough to attempt it.
  if (org.stripeSubscriptionId !== null) {
    throw new ApiError(
      "CONFLICT",
      "This account already has a subscription. Change or cancel it from the billing page."
    );
  }

  const catalogue = await loadCatalogue(deps.db, ctx.now);
  const plan = resolveSellablePlan(catalogue, requested, interval);

  const customerId = await ensureCustomer(stripe, deps.db, org, ctx.now);

  // Back to the workspace they started from. The slug rather than the id,
  // because that is what every other dashboard URL uses and a raw id would
  // redirect — through Stripe's return, which is a worse place to bounce.
  const workspacePath = `${deps.dashboardUrl}/w/${ctx.workspace.slug ?? ctx.workspaceId}/billing`;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceIdFor(plan, interval)!, quantity: 1 }],
    success_url: `${workspacePath}?checkout=success`,
    cancel_url: `${workspacePath}?checkout=cancelled`,
    // Both so that a Stripe-side investigation can reach the account from
    // either the session or the subscription it produces, without matching on
    // an email that may be shared.
    client_reference_id: org.id,
    // On the subscription, not only the session. The subscription outlives the
    // session by definition, and every later `customer.subscription.*` event
    // carries this metadata with it — which is what lets a support engineer
    // reading a Stripe event resolve it to an account without a lookup.
    subscription_data: {
      metadata: { agentdisk_org_id: org.id, agentdisk_plan: plan.id },
    },
    metadata: { agentdisk_org_id: org.id, agentdisk_plan: plan.id },
    allow_promotion_codes: true,

    /* ------------------------------- tax -------------------------------- */
    //
    // Stripe Tax is enabled on the account, but that is a capability rather
    // than an instruction: the dashboard's "calculate automatically" default
    // covers Payment Links and invoices raised in the dashboard, and an
    // API-created Checkout Session has to ask. Without this line the session is
    // created with tax calculation off however the account is configured, and
    // the failure is silent — a correct-looking charge for the list price with
    // no tax row on it.
    //
    // AgentDisk is a Delaware corporation selling digital services worldwide,
    // so the supplier of record is the company: Stripe computes and reports,
    // it does not register or file. This line is the computation, not the
    // obligation.
    automatic_tax: { enabled: true },

    // Required, and not only because `automatic_tax` needs somewhere to send
    // the question. EU rules for digital services want two non-contradictory
    // pieces of evidence of where the customer is, and the card's country is
    // one. **This is the part that cannot be recovered later** — a charge taken
    // without an address is a charge whose jurisdiction has to be reconstructed
    // from Stripe a year afterwards, if it can be established at all.
    billing_address_collection: "required",

    // So a business customer can enter a VAT or GST number. With one, the
    // reverse charge applies and they can reclaim; without the field they
    // simply absorb the tax, which is the quiet reason a B2B customer does not
    // come back.
    tax_id_collection: { enabled: true },
  });

  if (session.url === null) {
    throw new ApiError("INTERNAL_ERROR", "Could not start checkout.", {
      internalReason: `checkout session ${session.id} came back with no url`,
    });
  }

  return json({ url: session.url });
}

/**
 * POST /v1/billing/cancel — stop renewing at the end of the paid period.
 *
 * `cancel_at_period_end`, never an immediate cancellation. The customer paid
 * for the period; taking it away the moment they press Cancel would be keeping
 * their money and withdrawing the service, and it makes the decision feel
 * irreversible in a way it is not. They keep everything until the date, and
 * `resumeSubscription` takes it back until that date arrives.
 *
 * Nothing about entitlements changes here. The account stays `active` on its
 * paid plan; only `cancel_at_period_end` moves, so the screen can say "Ends"
 * instead of "Renews". Stripe sends `customer.subscription.deleted` when the
 * date actually arrives, and that is what drops the plan to free.
 */
export async function cancelSubscription(
  ctx: AuthContext,
  deps: BillingDeps
): Promise<Response> {
  const { org, stripe } = await ownerContext(ctx, deps, "cancel the subscription");

  if (org.stripeSubscriptionId === null) {
    throw new ApiError("CONFLICT", "There is no subscription to cancel.");
  }
  if (org.cancelAtPeriodEnd) {
    // Already done. Answering 200 rather than a conflict: the caller wanted the
    // subscription to be cancelling and it is, so a second press of a button on
    // a stale tab should not read as an error.
    return json({ cancelAtPeriodEnd: true, periodEndsAt: org.currentPeriodEnd });
  }

  // Any pending downgrade has to go first. A schedule owns the subscription's
  // future phases, and Stripe refuses to cancel underneath one — so a customer
  // who downgraded last week and cancels today would otherwise hit an error
  // naming a Stripe object they have never heard of.
  await releaseSchedule(stripe, org.stripeSubscriptionId);

  const subscription = await stripe.subscriptions.update(org.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });

  // Written here as well as by the webhook that follows. The webhook is
  // authoritative, but it arrives asynchronously and the customer is about to
  // re-read this screen — leaving the write to Stripe alone means the button
  // they just pressed appears not to have worked.
  await applyCancelFlag(deps.db, org.id, true, ctx.now);

  return json({
    cancelAtPeriodEnd: true,
    periodEndsAt: periodEndMs(subscription) ?? org.currentPeriodEnd,
  });
}

/** POST /v1/billing/resume — take back a cancellation before it takes effect. */
export async function resumeSubscription(
  ctx: AuthContext,
  deps: BillingDeps
): Promise<Response> {
  const { org, stripe } = await ownerContext(ctx, deps, "resume the subscription");

  if (org.stripeSubscriptionId === null) {
    // The period already ended and Stripe deleted the subscription. There is
    // nothing to resume, and saying so beats a Stripe error about a missing
    // object — the customer's next step is to subscribe again.
    throw new ApiError(
      "CONFLICT",
      "This subscription has already ended. Choose a plan to start a new one."
    );
  }

  const subscription = await stripe.subscriptions.update(org.stripeSubscriptionId, {
    cancel_at_period_end: false,
  });

  await applyCancelFlag(deps.db, org.id, false, ctx.now);

  return json({
    cancelAtPeriodEnd: false,
    periodEndsAt: periodEndMs(subscription) ?? org.currentPeriodEnd,
  });
}

/**
 * POST /v1/billing/change-plan — move a live subscription to another plan or
 * cadence.
 *
 * ── The asymmetry, and why it is the honest one ────────────────────────────
 * An upgrade takes effect immediately with prorations; a downgrade takes effect
 * at the end of the period the customer already paid for. That is what Dropbox
 * does, what amardrive does, and it is not arbitrary: somebody paying more
 * should get what they paid for now, and somebody paying less should not be
 * cut down to a smaller allowance in weeks they have already bought.
 *
 * The downgrade direction has a second reason specific to storage. Dropping a
 * 500 GB Team account to Pro's 50 GB the instant they press the button puts
 * them 450 GB over quota through no act of their own, with every write refused
 * until they delete something. Deferring it to the period end gives them the
 * rest of the month to get under the new limit.
 *
 * Both directions compare **effective monthly cost**, so monthly-to-yearly on
 * the same plan reads as the lateral move it is rather than as a 10× upgrade.
 */
export async function changePlan(
  ctx: AuthContext,
  request: Request,
  deps: BillingDeps
): Promise<Response> {
  const { org, stripe } = await ownerContext(ctx, deps, "change the plan");
  const { plan: requested, interval } = await readPlanBody(request);

  if (org.stripeSubscriptionId === null) {
    throw new ApiError(
      "CONFLICT",
      "There is no subscription to change. Choose a plan to start one."
    );
  }

  const catalogue = await loadCatalogue(deps.db, ctx.now);
  const target = resolveSellablePlan(catalogue, requested, interval);
  const targetPriceId = priceIdFor(target, interval)!;

  const subscription = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
  const item = subscription.items.data[0];
  if (item === undefined) {
    throw new ApiError("INTERNAL_ERROR", "Could not read the current subscription.", {
      internalReason: `subscription ${subscription.id} has no items`,
    });
  }
  if (item.price.id === targetPriceId) {
    throw new ApiError("CONFLICT", "This account is already on that plan.");
  }

  const currentPlan = catalogue.get(org.plan) ?? null;
  const currentCost =
    currentPlan === null || org.billingInterval === null
      ? 0
      : effectiveMonthlyCents(currentPlan, org.billingInterval);
  const targetCost = effectiveMonthlyCents(target, interval);

  // A pending downgrade is released before either branch runs. Stripe blocks an
  // update to a subscription a schedule owns, and a customer who downgraded on
  // Monday and changed their mind on Tuesday must not meet that error.
  await releaseSchedule(stripe, subscription);

  if (targetCost >= currentCost) {
    await stripe.subscriptions.update(subscription.id, {
      items: [{ id: item.id, price: targetPriceId }],
      proration_behavior: "create_prorations",
      // The metadata has to move with the plan, or every later event on this
      // subscription would still name the plan it used to be on.
      metadata: { agentdisk_org_id: org.id, agentdisk_plan: target.id },
      // The upgrade is being paid for now, so the invoice is raised now. Left
      // to Stripe's default the prorations would sit as pending line items
      // until the next period, which means an "immediate" upgrade the customer
      // is not billed for until next month.
      proration_date: Math.floor(ctx.now / 1000),
    });

    // Not written locally. `customer.subscription.updated` settles the plan,
    // the interval and the period, and doing it in two places is how they
    // disagree — the webhook is the one that also fires for a change made in
    // the Stripe dashboard.
    return json({ effective: "now", plan: target.id, interval });
  }

  /* ---------------------------- the downgrade ---------------------------- */

  const periodEnd = periodEndMs(subscription);
  const schedule = await stripe.subscriptionSchedules.create({
    from_subscription: subscription.id,
  });
  const startDate = schedule.phases[0]?.start_date;

  await stripe.subscriptionSchedules.update(schedule.id, {
    // Release hands the subscription back to itself once the last phase ends,
    // rather than leaving it owned by a schedule forever — without it, the next
    // plan change months later meets a schedule nobody remembers creating.
    end_behavior: "release",
    phases: [
      {
        items: [{ price: item.price.id, quantity: 1 }],
        ...(startDate === undefined ? {} : { start_date: startDate }),
        end_date: Math.floor((periodEnd ?? ctx.now) / 1000),
        // No proration in either phase. The customer keeps what they paid for
        // and then starts the cheaper plan; there is nothing to refund and
        // nothing to charge, which is exactly what "at the end of the period"
        // is supposed to mean.
        proration_behavior: "none",
      },
      {
        items: [{ price: targetPriceId, quantity: 1 }],
        // One period, then `end_behavior: "release"` hands the subscription
        // back to itself and it carries on billing this price by itself. The
        // schedule exists only to cross the boundary; it is not meant to own
        // the subscription for the rest of its life.
        //
        // `duration` rather than `iterations`: the pinned API version replaced
        // the latter, and the two are not interchangeable spellings — passing
        // `iterations` is rejected outright.
        duration: { interval: interval === "year" ? "year" : "month", interval_count: 1 },
        proration_behavior: "none",
        metadata: { agentdisk_org_id: org.id, agentdisk_plan: target.id },
      },
    ],
  });

  // D1 deliberately stays on the CURRENT plan. The customer keeps the larger
  // allowance until Stripe actually crosses the boundary and sends
  // `customer.subscription.updated` — writing the smaller plan now would
  // enforce a quota they have not started paying the lower price for.
  return json({
    effective: "period_end",
    plan: target.id,
    interval,
    at: periodEnd ?? org.currentPeriodEnd,
  });
}

/* ------------------------------- plumbing -------------------------------- */

/**
 * The three refusals every write on this surface shares, in one place.
 *
 * An API key must never reach billing: a credential minted to upload files
 * should not be able to cancel the account's subscription, and the scope model
 * has nothing to say about money. A non-owner must not either, for the same
 * reason the portal is owner-only.
 */
async function ownerContext(
  ctx: AuthContext,
  deps: BillingDeps,
  action: string
): Promise<{ org: OrgBilling; stripe: Stripe }> {
  if (ctx.identity.kind !== "firebase_user") {
    throw forbidden(`Only a signed-in user can ${action}.`);
  }
  if (ctx.identity.role !== "owner") {
    throw forbidden("Only the account owner can manage billing.");
  }
  if (deps.secretKey === undefined || deps.secretKey === "") {
    // Fails closed and says why, the same shape as a missing Turnstile secret.
    throw new ApiError("INTERNAL_ERROR", "Billing is not configured.", {
      internalReason: "STRIPE_SECRET_KEY is not set",
    });
  }

  const org = await findOrgForWorkspace(deps.db, ctx.workspaceId);
  if (org === null) throw new ApiError("NOT_FOUND", "No billing account for this workspace.");

  return { org, stripe: stripeClient(deps.secretKey) };
}

/** `{ plan, interval }` out of a request body, or a named refusal. */
async function readPlanBody(
  request: Request
): Promise<{ plan: string; interval: BillingInterval }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw validationError("Send a JSON body naming a plan.");
  }
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  const plan = record["plan"];
  if (typeof plan !== "string" || plan === "") {
    throw validationError("Name the plan, as `plan`.");
  }

  // Defaulted rather than required, so an older client that only knows about
  // monthly keeps working against this endpoint rather than failing validation
  // on a field it has never sent.
  const interval = record["interval"] ?? "month";
  if (!isBillingInterval(interval)) {
    throw validationError("`interval` must be 'month' or 'year'.");
  }

  return { plan, interval };
}

/** A plan that exists, is public, costs money, and has a price at this cadence. */
function resolveSellablePlan(
  catalogue: Catalogue,
  planId: string,
  interval: BillingInterval
): PlanRow {
  const plan = catalogue.get(planId);
  if (plan === undefined || plan.is_public !== 1) {
    throw validationError(`No such plan: ${planId}.`);
  }
  if (plan.amount_cents === 0) {
    // Free is the absence of a subscription, not a $0 one. Subscribing at $0
    // would give every free account a real Stripe subscription that can go
    // past_due and dun somebody for nothing.
    throw validationError("The free plan does not require a subscription.");
  }
  if (priceIdFor(plan, interval) === null) {
    // The catalogue has the plan but not its price at this cadence — either the
    // Stripe sync has not run in this environment, or this plan is genuinely
    // not sold by the year. Said as an internal fault rather than a validation
    // error, because the caller did nothing wrong.
    throw new ApiError("INTERNAL_ERROR", "This plan is not available at that interval yet.", {
      internalReason: `plan ${plan.id} has no ${interval} price; run the catalogue sync`,
    });
  }
  return plan;
}

/**
 * Release a subscription schedule, if one owns this subscription.
 *
 * Releasing leaves the subscription exactly as it is and simply stops a schedule
 * from driving it, which is what any later change needs. It is idempotent by
 * omission: no schedule, nothing to do.
 */
async function releaseSchedule(
  stripe: Stripe,
  subscription: string | Stripe.Subscription
): Promise<void> {
  const live =
    typeof subscription === "string"
      ? await stripe.subscriptions.retrieve(subscription)
      : subscription;

  const scheduleId =
    typeof live.schedule === "string" ? live.schedule : (live.schedule?.id ?? null);
  if (scheduleId === null) return;

  try {
    await stripe.subscriptionSchedules.release(scheduleId);
  } catch (err) {
    // A schedule that already completed or was already released cannot be
    // released again, and that is not a failure of the thing the caller asked
    // for. Swallowed with a log rather than surfaced: the caller wanted no
    // schedule in the way, and there is none.
    console.log(
      JSON.stringify({
        level: "info",
        message: "subscription schedule could not be released",
        scheduleId,
        reason: err instanceof Error ? err.message : String(err),
      })
    );
  }
}

/** Stripe's period end, in milliseconds. Stripe speaks seconds; we do not. */
function periodEndMs(subscription: Stripe.Subscription): number | null {
  const seconds = subscription.items.data[0]?.current_period_end;
  return seconds === undefined ? null : seconds * 1000;
}

async function applyCancelFlag(
  db: D1Database,
  orgId: string,
  cancelling: boolean,
  now: number
): Promise<void> {
  await db
    .prepare(`UPDATE organizations SET cancel_at_period_end = ?, updated_at = ? WHERE id = ?`)
    .bind(cancelling ? 1 : 0, now, orgId)
    .run();
}

/**
 * Find or create the Stripe Customer for this organization.
 *
 * Created lazily, on first use, rather than at signup: a Customer object for
 * somebody who never opens billing is clutter in the Stripe dashboard that
 * nobody will ever reconcile.
 *
 * The idempotency key is the organization id, so a double-clicked button or a
 * retried request cannot leave two Customers for one account — which is the
 * kind of duplicate that only surfaces later, as two subscriptions on one card.
 */
async function ensureCustomer(
  stripe: Stripe,
  db: D1Database,
  org: OrgBilling,
  now: number
): Promise<string> {
  if (org.stripeCustomerId !== null) return org.stripeCustomerId;

  const customer = await stripe.customers.create(
    {
      email: org.ownerEmail,
      name: org.name,
      // So a Stripe-side investigation can get back to an account without
      // guessing from the email.
      metadata: { agentdisk_org_id: org.id },
    },
    { idempotencyKey: `org-customer-${org.id}` }
  );

  await attachStripeCustomer(db, org.id, customer.id, now);
  return customer.id;
}
