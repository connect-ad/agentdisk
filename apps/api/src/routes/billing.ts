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
 * ── And nothing renews by itself ────────────────────────────────────────────
 * Owner's decision, 23 September 2026. A purchase buys one month and stops; the
 * customer is reminded seven days out, locked at expiry, and their data is
 * scheduled for deletion seven days after that. `lib/renewal.ts` owns the
 * clock, `jobs/billing-renewal.ts` walks it.
 *
 * The consequence for this file is that checkout creates a **payment**, not a
 * subscription — see the session below for why that distinction is a safety
 * property and not a preference.
 *
 * Stripe's hosted portal survives as invoice history and nothing else. There is
 * no subscription left for it to cancel and no card kept on file for it to
 * update, but it is still the only place a receipt lives, and rebuilding an
 * invoice list here would mean re-implementing a compliance-sensitive surface
 * with none of the controls Stripe already has.
 */

import { ApiError, forbidden, validationError } from "../lib/errors";
import { stripeClient } from "../billing/stripe";
import {
  attachStripeCustomer,
  findOrgForWorkspace,
  type OrgBilling,
} from "../billing/organizations";
import { loadCatalogue, type Catalogue } from "../billing/catalogue";
import { RENEWAL_REMINDER_MS, deletionScheduledAt } from "../lib/renewal";
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

/**
 * Which plans this account could actually buy right now.
 *
 * Ids only, and that is the whole point of it being here rather than a table of
 * names and prices. Every number a customer reads - price, storage, agent
 * count - is hardcoded in the dashboard and on the marketing page, so the
 * server has no business restating it.
 *
 * The one thing the front end genuinely cannot know is this: whether a plan has
 * a Stripe price in THIS environment. Migration 0012 seeds the catalogue with
 * `stripe_price_id = NULL`, because the products do not exist in Stripe at
 * migration time, and they stay NULL until the catalogue sync has run. A
 * dashboard that assumed otherwise would render an upgrade button whose only
 * outcome is a 500.
 *
 * Free is excluded because it is the absence of a subscription rather than a
 * thing to buy.
 */
function purchasablePlanIds(catalogue: Catalogue): string[] {
  return [...catalogue.values()]
    .filter((row) => row.is_public === 1 && row.amount_cents > 0 && row.stripe_price_id !== null)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((row) => row.id);
}

/** What the Billing screen renders. Safe for any member to read. */
export async function getBilling(ctx: AuthContext, deps: BillingDeps): Promise<Response> {
  const org = await findOrgForWorkspace(deps.db, ctx.workspaceId);
  if (org === null) throw new ApiError("NOT_FOUND", "No billing account for this workspace.");

  const catalogue = await loadCatalogue(deps.db, ctx.now);

  return json({
    // Ids, not a plan table. See purchasablePlanIds: the numbers are hardcoded
    // client-side, and the only thing the dashboard cannot work out for itself
    // is which plans have a synced Stripe price in this environment.
    purchasable: purchasablePlanIds(catalogue),
    billing: {
      plan: org.plan,
      status: org.billingStatus,
      /** False until somebody opens the portal for the first time. */
      configured: org.stripeCustomerId !== null,
      subscribed: org.stripeSubscriptionId !== null,
      ownerEmail: org.ownerEmail,
      // Said explicitly rather than left for the UI to infer from the status
      // string, so the rule lives in one place.
      writesBlocked: org.billingStatus !== "active",

      /* ------------------------ the renewal clock ------------------------ */
      //
      // These four are the whole reason this response grew. Under manual
      // renewal the date a plan runs out is the single most important fact a
      // customer has, and until now the API returned nothing about it — there
      // was no column to return. They come straight off `organizations`, so
      // none of this costs a Stripe call.

      /** When the paid period ends. Null for an account that never bought one. */
      periodEndsAt: org.currentPeriodEnd,
      /**
       * Stated rather than left to the client's clock. A browser an hour behind
       * would otherwise decide for itself whether a renewal window is open, and
       * disagree with the server that will actually refuse the checkout.
       */
      renewalOpen: renewalWindowOpen(org.currentPeriodEnd, ctx.now),
      /** When the grace ends and data is scheduled for deletion, once expired. */
      graceEndsAt:
        org.currentPeriodEnd === null ? null : deletionScheduledAt(org.currentPeriodEnd),
      /**
       * Set once a sweep has actually stamped the account. Distinct from
       * `graceEndsAt`, which is only ever a projection: this one means it has
       * happened, and renewing is what clears it.
       */
      purgeAfter: org.purgeAfter,
    },
  });
}

/**
 * Whether a purchase is allowed right now.
 *
 * Closed while a paid period is comfortably live, for two different reasons
 * that happen to share an answer. Buying the same plan twice would charge for a
 * month already paid for; buying a *different* one mid-period is a plan change,
 * and proration is deliberately out of scope — Stripe's own machinery for it is
 * the part of a billing system most likely to bill somebody wrongly.
 *
 * It opens for the last seven days, which is exactly when the reminder email
 * lands. That email's whole purpose is to get somebody to renew before their
 * period ends, so a window that refused them would make the reminder a lie.
 */
function renewalWindowOpen(currentPeriodEnd: number | null, now: number): boolean {
  if (currentPeriodEnd === null) return true;
  return currentPeriodEnd - now <= RENEWAL_REMINDER_MS;
}

/**
 * A one-time URL into Stripe's hosted portal.
 *
 * Owner-only. The portal can cancel the subscription and change the card, which
 * is authority over the account rather than over this workspace's contents —
 * the same line that separates an admin from an owner everywhere else.
 */
export async function createPortalSession(
  ctx: AuthContext,
  deps: BillingDeps
): Promise<Response> {
  if (ctx.identity.kind !== "firebase_user") {
    throw forbidden("Only a signed-in user can open billing.");
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

  const stripe = stripeClient(deps.secretKey);
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
 * The one thing the product could not do before this: take money. The portal
 * handles everything *after* a subscription exists — cards, cancellation, plan
 * changes — but it cannot create the first one, so Pro and Team were priced and
 * unbuyable (backlog/024).
 *
 * Owner-only, on the same reasoning as the portal: committing the account to a
 * recurring charge is authority over the billing account, not over one
 * workspace's contents.
 *
 * The client names OUR plan id, never a Stripe price. That keeps the mapping
 * server-side, where the catalogue already is — a caller who could pass a price
 * id could subscribe the account to any price in the Stripe account, including
 * an archived one nobody is meant to be sold any more.
 */
export async function createCheckoutSession(
  ctx: AuthContext,
  request: Request,
  deps: BillingDeps
): Promise<Response> {
  if (ctx.identity.kind !== "firebase_user") {
    throw forbidden("Only a signed-in user can start a subscription.");
  }
  if (ctx.identity.role !== "owner") {
    throw forbidden("Only the account owner can manage billing.");
  }
  if (deps.secretKey === undefined || deps.secretKey === "") {
    throw new ApiError("INTERNAL_ERROR", "Billing is not configured.", {
      internalReason: "STRIPE_SECRET_KEY is not set",
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw validationError("Send a JSON body naming a plan.");
  }
  const requested =
    typeof body === "object" && body !== null && "plan" in body
      ? (body as { plan: unknown }).plan
      : undefined;
  if (typeof requested !== "string" || requested === "") {
    throw validationError("Name the plan to subscribe to, as `plan`.");
  }

  const org = await findOrgForWorkspace(deps.db, ctx.workspaceId);
  if (org === null) throw new ApiError("NOT_FOUND", "No billing account for this workspace.");

  // A real Stripe Subscription, from before this product stopped using them or
  // created by hand in the dashboard. Nothing in this code path makes one any
  // more, but if one exists it is the thing actually billing the customer, and
  // selling them a one-off month on top would charge twice for the same weeks.
  if (org.stripeSubscriptionId !== null) {
    throw new ApiError(
      "CONFLICT",
      "This account already has a subscription. Change or cancel it from the billing portal."
    );
  }

  // Already paid up, and not yet near the end. See `renewalWindowOpen`: this
  // refuses both a duplicate purchase and a mid-period plan change, and the
  // message has to serve both because the caller knows which they attempted.
  if (!renewalWindowOpen(org.currentPeriodEnd, ctx.now)) {
    throw new ApiError(
      "CONFLICT",
      "This plan is paid for until it ends. You can renew, or switch plans, in the last 7 days of the period."
    );
  }

  const catalogue = await loadCatalogue(deps.db, ctx.now);
  const plan = catalogue.get(requested);
  if (plan === undefined || plan.is_public !== 1) {
    throw validationError(`No such plan: ${requested}.`);
  }
  if (plan.amount_cents === 0) {
    // Free is the absence of a subscription, not a $0 one. Checking out at $0
    // would give every free account a real Stripe subscription that can go
    // past_due and dun somebody for nothing.
    throw validationError("The free plan does not require a subscription.");
  }
  if (plan.stripe_price_id === null) {
    // The catalogue has the plan but not its price, which means the Stripe
    // sync has not run in this environment. Said as an internal fault rather
    // than a validation error, because the caller did nothing wrong and
    // retrying with a different plan will not help.
    throw new ApiError("INTERNAL_ERROR", "This plan is not available for purchase yet.", {
      internalReason: `plan ${plan.id} has no stripe_price_id; run the catalogue sync`,
    });
  }

  const stripe = stripeClient(deps.secretKey);
  const customerId = await ensureCustomer(stripe, deps.db, org, ctx.now);

  // Back to the workspace they started from. The slug rather than the id,
  // because that is what every other dashboard URL uses and a raw id would
  // redirect - through Stripe's return, which is a worse place to bounce.
  const workspacePath = `${deps.dashboardUrl}/w/${ctx.workspace.slug ?? ctx.workspaceId}/billing`;

  // `payment`, not `subscription`, and this is the whole expression of the
  // owner's decision that AgentDisk does not auto-renew.
  //
  // The obvious alternative is a Subscription with `cancel_at_period_end` set.
  // It was rejected because its failure mode is charging somebody without
  // consent: one missed flag and the customer is billed again, silently, which
  // is exactly the outcome being ruled out. A one-off payment cannot do that —
  // Stripe holds no mandate and has nothing to charge against. The property is
  // structural rather than a setting that could be wrong.
  //
  // `invoice_creation` because the receipt still has to exist. Without it a
  // `payment` session leaves a charge and no invoice, and the billing portal —
  // which is now only good for invoice history — would have nothing to show.
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
    success_url: `${workspacePath}?checkout=success`,
    cancel_url: `${workspacePath}?checkout=cancelled`,
    // Both so that a Stripe-side investigation can reach the account from
    // either the session or the charge it produces, without matching on an
    // email that may be shared.
    client_reference_id: org.id,
    // On the session itself now. There is no subscription to hang metadata
    // from, and `checkout.session.completed` is the only event that resolves
    // this purchase back to a plan — `findPlanByPriceId` cannot help, because a
    // one-off session's line items are not re-read on the webhook.
    metadata: { agentdisk_org_id: org.id, agentdisk_plan: plan.id },
    invoice_creation: { enabled: true },
    allow_promotion_codes: true,
  });

  if (session.url === null) {
    throw new ApiError("INTERNAL_ERROR", "Could not start checkout.", {
      internalReason: `checkout session ${session.id} came back with no url`,
    });
  }

  return json({ url: session.url });
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
  stripe: ReturnType<typeof stripeClient>,
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
