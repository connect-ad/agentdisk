/**
 * POST /v1/webhooks/stripe — 14 PART 29.3.
 *
 * Deliberately distinct from the product's own `/v1/webhooks` surface, which is
 * customers registering *their* endpoints with *us*. This is us receiving
 * events from Stripe as Stripe's customer. Same word, two unrelated things, and
 * conflating them in the codebase would be a genuinely confusing mistake.
 *
 * Three rules:
 *
 * **Verify before parsing.** The signature check happens against the raw body
 * text, before anything reads a field. An unsigned payload is not an event, it
 * is a stranger's POST, and treating it as one for even a moment is how a
 * forged `invoice.payment_succeeded` gets somebody the product for free.
 *
 * **Unknown events are acknowledged, not rejected.** Stripe sends whatever the
 * endpoint is subscribed to, and answering non-2xx makes it retry with backoff
 * and eventually disable the endpoint. An event we do not handle is not a
 * failure.
 *
 * **A handler that throws returns non-2xx on purpose.** That is the only way to
 * ask Stripe to redeliver, and redelivery is the entire recovery story for a
 * transient D1 failure here — there is no queue behind this.
 *
 * ── The ten events this endpoint is subscribed to ───────────────────────────
 * Recorded here because the subscription list lives in the Stripe dashboard,
 * where nothing in this repository can assert it. If the two fall out of step
 * the failure is silent in the worst direction: an event we handle but no
 * longer receive looks exactly like an event that never fired.
 *
 *   customer.subscription.created    \
 *   customer.subscription.updated    | the subscription's whole life — plan,
 *   customer.subscription.deleted    /  period, cadence, cancellation, ending
 *   invoice.payment_failed           dunning opens
 *   invoice.payment_succeeded        dunning closes; the period was paid for
 *   checkout.session.completed       binds the new subscription to the account
 *   product.created                  \
 *   product.updated                  | the catalogue, mirrored into D1
 *   product.deleted                  /
 *   charge.refunded                  recorded, entitlements deliberately untouched
 *
 * ── Where service is actually granted ───────────────────────────────────────
 * `customer.subscription.created` / `.updated`. Since auto-renewal returned
 * (25 September 2026) the subscription object is the record of what the account
 * is entitled to and until when, and those two events mirror it: the plan from
 * the price, the period from Stripe's own `current_period_end`, the cadence,
 * and whether it is set to stop.
 *
 * `checkout.session.completed` is deliberately the thin half of that pair. It
 * binds the new subscription id to the organization and nothing else — the
 * subscription events carry the price and arrive for every later change too, so
 * duplicating the entitlement write here would mean two code paths that have to
 * agree forever.
 *
 * ── The two ways a subscription ends, and why they differ ───────────────────
 * `customer.subscription.deleted` fires for both, and answering them the same
 * way would be wrong in one direction or the other:
 *
 *   the customer cancelled   → `canceled`, plan drops to free. They chose this
 *                              and their period is over; nothing is scheduled
 *                              for deletion because they may well come back.
 *   Stripe could not collect → `expired`, plan deliberately LEFT on the paid
 *                              tier, and the deletion ladder keeps running.
 *
 * Leaving the plan alone on a payment failure is the rule migration 0027 set
 * and it survives the return to auto-renewal: dropping a 500 GB account to
 * Free's 1 GB puts it instantly over quota through no act of its own, during
 * the exact window we are asking it to fix its card.
 *
 * charge.refunded owns nothing — see its case for why a refund must not move
 * entitlements.
 */

import { ApiError } from "../lib/errors";
import { constructEvent, stripeClient, type Stripe } from "../billing/stripe";
import {
  applySubscriptionState,
  findOrgByCustomerId,
  findPlanByPriceId,
  type BillingStatus,
  type OrgRef,
} from "../billing/organizations";
import { retirePlanForProduct, syncProductToPlan } from "../billing/plan-sync";
import type { BillingInterval } from "../lib/renewal";

export interface WebhookDeps {
  db: D1Database;
  secretKey?: string;
  webhookSecret?: string;
  now: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Which of our plans a subscription is on, and at which cadence, from the price
 * it carries.
 *
 * Undefined rather than a guess. Leaving the plan alone is safer than resolving
 * an unknown price to something arbitrary — one direction keeps billing and
 * entitlement in step, the other silently upgrades or downgrades somebody
 * because a price was renamed in Stripe.
 */
async function planFromSubscription(
  db: D1Database,
  subscription: Stripe.Subscription
): Promise<{ id: string; interval: BillingInterval } | undefined> {
  const priceId = subscription.items.data[0]?.price?.id;
  if (priceId === undefined) return undefined;
  return (await findPlanByPriceId(db, priceId)) ?? undefined;
}

/**
 * Stripe's period end for a subscription, in milliseconds.
 *
 * On the item rather than the subscription: the top-level `current_period_end`
 * was removed in recent API versions, and a subscription's period genuinely
 * belongs to its items once more than one price can sit on it. We sell exactly
 * one item per subscription, so the first is the answer.
 */
function periodEndMs(subscription: Stripe.Subscription): number | null {
  const seconds = subscription.items.data[0]?.current_period_end;
  return seconds === undefined ? null : seconds * 1000;
}

/**
 * Did this subscription end because we could not collect, rather than because
 * the customer asked?
 *
 * Stripe's own reason is preferred, because it is the direct answer. Our
 * `past_due` state is the fallback for an API version or a path that does not
 * populate it — an account mid-dunning whose subscription vanishes did not
 * cancel, whatever the event says.
 */
function endedForNonPayment(subscription: Stripe.Subscription, org: OrgRef): boolean {
  const reason = subscription.cancellation_details?.reason;
  if (reason === "payment_failed") return true;
  if (reason === "cancellation_requested") return false;
  return org.billingStatus === "past_due" || org.pastDueSince !== null;
}

/**
 * Stripe's subscription statuses, mapped onto the three this product enforces.
 *
 * `past_due` and `unpaid` block writes; `canceled` and the terminal failures do
 * too. Everything else - including `trialing` - is active. Mapping an unknown
 * status to active is the deliberate direction: a status Stripe adds later must
 * not lock out paying customers on the day they add it.
 */
function statusFrom(subscription: Stripe.Subscription): BillingStatus {
  switch (subscription.status) {
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return "active";
  }
}

function customerIdOf(value: string | { id: string } | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : value.id;
}

/** The organization behind a Stripe customer, for any event that names one. */
async function orgFromCustomer(
  db: D1Database,
  customer: string | { id: string } | null | undefined
): Promise<OrgRef | null> {
  const customerId = customerIdOf(customer);
  if (customerId === null) return null;
  return findOrgByCustomerId(db, customerId);
}

/**
 * An organization by its own id, for `client_reference_id`.
 *
 * Checked against the table rather than trusted: the value arrives inside a
 * signed event, so it is not forgeable, but it is still a string we put into
 * Stripe months ago and an organization can have been deleted since.
 */
async function findOrgById(db: D1Database, orgId: string): Promise<OrgRef | null> {
  return db
    .prepare(
      `SELECT id, plan, current_period_end AS currentPeriodEnd,
              past_due_since AS pastDueSince, billing_status AS billingStatus
         FROM organizations WHERE id = ?`
    )
    .bind(orgId)
    .first<OrgRef>();
}

export async function handleStripeWebhook(
  request: Request,
  deps: WebhookDeps
): Promise<Response> {
  if (deps.secretKey === undefined || deps.webhookSecret === undefined) {
    throw new ApiError("INTERNAL_ERROR", "Billing is not configured.", {
      internalReason: "STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is not set",
    });
  }

  const signature = request.headers.get("stripe-signature");
  if (signature === null) {
    throw new ApiError("UNAUTHORIZED", "Missing signature.", {
      internalReason: "no stripe-signature header",
    });
  }

  // The raw text, before any parsing. The signature covers these exact bytes,
  // so round-tripping through JSON first would break the check on nothing more
  // than key ordering or whitespace.
  const payload = await request.text();

  const stripe = stripeClient(deps.secretKey);
  let event: Stripe.Event;
  try {
    event = await constructEvent(stripe, payload, signature, deps.webhookSecret);
  } catch (err) {
    throw new ApiError("UNAUTHORIZED", "Signature verification failed.", {
      internalReason: err instanceof Error ? err.message : String(err),
    });
  }

  const handled = await apply(event, deps);
  // The event type is echoed so a delivery can be matched to what we did with
  // it from Stripe's own dashboard, without needing our logs.
  return json({ received: true, type: event.type, handled });
}

async function apply(event: Stripe.Event, deps: WebhookDeps): Promise<boolean> {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      // Where entitlement actually comes from. Everything the account is
      // allowed and until when is settled here, from the subscription object
      // Stripe maintains — so a change made in the Stripe dashboard lands in
      // this product exactly as one made through `changePlan` does.
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = customerIdOf(subscription.customer);
      if (customerId === null) return false;

      const org = await findOrgByCustomerId(deps.db, customerId);
      if (org === null) return false;

      const plan = await planFromSubscription(deps.db, subscription);
      const status = statusFrom(subscription);

      // A subscription that is active again has come back from dunning, and
      // both stamps have to be lifted together: `past_due_since` because the
      // run is over, and `purge_after` because a sweep may already have
      // scheduled this account's data for deletion during it.
      //
      // **This is the single most important write in the feature.** Somebody
      // whose card clears on day ten must not be deleted by a job that stamped
      // them on day seven. It was true under manual renewal and it is more
      // easily missed here, because the recovery is Stripe's retry rather than
      // a customer pressing a button.
      const recovered = status === "active";

      await applySubscriptionState(
        deps.db,
        org.id,
        {
          plan: plan?.id,
          billingInterval: plan?.interval,
          billingStatus: status,
          subscriptionId: subscription.id,
          currentPeriodEnd: periodEndMs(subscription),
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          ...(recovered ? { pastDueSince: null, purgeAfter: null } : {}),
        },
        deps.now
      );
      return true;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = customerIdOf(subscription.customer);
      if (customerId === null) return false;

      const org = await findOrgByCustomerId(deps.db, customerId);
      if (org === null) return false;

      if (endedForNonPayment(subscription, org)) {
        // Stripe exhausted its retries. This is day +7 of the ladder, and the
        // account moves to `expired` rather than `canceled` — a different word
        // for a different thing, and the one the deletion sweep looks for.
        //
        // The plan is deliberately LEFT on the paid tier. Dropping a 500 GB
        // account to Free's 1 GB would put it instantly over quota through no
        // act of its own, and every usage screen would report a breach the
        // customer cannot fix except by deleting data we are simultaneously
        // telling them we may delete.
        //
        // `past_due_since` is deliberately kept too: it is what
        // `deletionScheduledAt` counts from, so clearing it here would leave
        // the scheduling pass with nothing to anchor on.
        await applySubscriptionState(
          deps.db,
          org.id,
          {
            billingStatus: "expired",
            subscriptionId: null,
            cancelAtPeriodEnd: false,
          },
          deps.now
        );
        return true;
      }

      // The customer cancelled and the period they paid for has now run out.
      //
      // The plan drops to free and the period is cleared with it: the period
      // was that subscription's, and leaving it behind would have the dashboard
      // promising a date nothing will honour. Nothing is scheduled for
      // deletion — they chose to stop paying, which is not the same as failing
      // to, and their data stays under the free allowance like any other free
      // account's.
      await applySubscriptionState(
        deps.db,
        org.id,
        {
          plan: "free",
          billingStatus: "canceled",
          subscriptionId: null,
          currentPeriodEnd: null,
          billingInterval: null,
          cancelAtPeriodEnd: false,
          pastDueSince: null,
        },
        deps.now
      );
      return true;
    }

    case "checkout.session.completed": {
      // Deliberately thin: this binds the new subscription to the organization
      // and stops there.
      //
      // Everything the purchase MEANS — the plan, the cadence, the period —
      // arrives moments later on `customer.subscription.created`, which carries
      // the price and fires again for every subsequent change. Settling
      // entitlements in both places would be two code paths that have to agree
      // forever, and the one that fires more often would eventually win an
      // argument nobody knew they were having.
      const session = event.data.object as Stripe.Checkout.Session;

      // client_reference_id first: it is ours, we set it at checkout, and it
      // survives a customer object being merged or replaced on Stripe's side.
      // The customer id is the fallback for a session created elsewhere.
      const org =
        (session.client_reference_id !== null
          ? await findOrgById(deps.db, session.client_reference_id)
          : null) ??
        (await orgFromCustomer(deps.db, session.customer));
      if (org === null) return false;

      if (session.mode !== "subscription") {
        // A one-off payment session. This product stopped creating them on
        // 25 September 2026, but one raised by hand in the Stripe dashboard
        // still arrives here and is not something to fail on.
        return false;
      }

      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : (session.subscription?.id ?? null);
      if (subscriptionId === null) return false;

      await applySubscriptionState(
        deps.db,
        org.id,
        { subscriptionId, cancelAtPeriodEnd: false },
        deps.now
      );
      return true;
    }

    case "product.created":
    case "product.updated": {
      // The catalogue, mirrored. Entitlements live in Product.metadata because
      // Stripe has no concept of "50 GB"; see billing/plan-sync.ts for why the
      // price is fetched rather than read off the product, and why a
      // product.created delivery often lands before its price exists.
      const product = event.data.object as Stripe.Product;
      if (deps.secretKey === undefined) return false;
      const result = await syncProductToPlan(
        deps.db,
        stripeClient(deps.secretKey),
        product,
        deps.now
      );
      return result !== null;
    }

    case "product.deleted": {
      // Retired, never removed. The row is what resolves a subscription's price
      // back to entitlements, so deleting it would drop everybody still on that
      // plan to the default - the opposite of what retiring a plan means.
      const product = event.data.object as Stripe.Product;
      return (await retirePlanForProduct(deps.db, product, deps.now)) !== null;
    }

    case "charge.refunded": {
      // Acknowledged and recorded, deliberately WITHOUT touching entitlements.
      //
      // A refund is a money event, not a subscription lifecycle event. Refunding
      // an invoice does not end a subscription, and Stripe will send
      // customer.subscription.deleted separately if one actually ends. Changing
      // the plan or the billing status here would either double-apply that
      // cancellation or, worse, revoke access from somebody who was refunded a
      // single month as a goodwill gesture and is still a paying customer.
      //
      // It is logged rather than dropped because a refund is exactly the kind
      // of thing support needs to see when somebody asks why their access
      // changed - and the answer, usually, is that it did not.
      const charge = event.data.object as Stripe.Charge;
      const org = await orgFromCustomer(deps.db, charge.customer);
      console.log(
        JSON.stringify({
          level: "info",
          message: "stripe charge refunded",
          orgId: org?.id ?? null,
          chargeId: charge.id,
          amountRefunded: charge.amount_refunded,
          currency: charge.currency,
          fullyRefunded: charge.refunded,
          note: "entitlements deliberately unchanged; subscription events own that",
        })
      );
      return org !== null;
    }

    case "invoice.payment_failed": {
      // Day 0 of the ladder. Writes stop; reads keep working, because somebody
      // whose card expired must still be able to get their data out — and must
      // still be able to reach the page where they would fix it.
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = customerIdOf(invoice.customer);
      if (customerId === null) return false;

      const org = await findOrgByCustomerId(deps.db, customerId);
      if (org === null) return false;

      await applySubscriptionState(
        deps.db,
        org.id,
        {
          billingStatus: "past_due",
          // **Only if a run is not already open.** Stripe retries a failing
          // card several times over the grace window and each attempt sends
          // this event; overwriting the stamp on every one would push the
          // deletion date back with each retry, and an account could stay in
          // grace indefinitely precisely because its card kept failing.
          //
          // A redelivered event is the same hazard and is covered by the same
          // guard, which is why it is a condition and not a blind write.
          ...(org.pastDueSince === null ? { pastDueSince: deps.now } : {}),
        },
        deps.now
      );
      return true;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = customerIdOf(invoice.customer);
      if (customerId === null) return false;

      const org = await findOrgByCustomerId(deps.db, customerId);
      if (org === null) return false;

      // Only lifts `past_due`. A payment succeeding on a canceled subscription
      // does not un-cancel it — that is what a new subscription event is for,
      // and quietly reactivating here would restore access somebody deliberately
      // gave up.
      //
      // The `expired` state is deliberately NOT lifted here either. By then
      // Stripe has deleted the subscription, so a payment arriving against it
      // is a late settlement of an old invoice rather than a renewal; treating
      // it as one would unlock an account with nothing left to bill it.
      // Returning from expiry is a new checkout.
      const updated = await deps.db
        .prepare(
          `UPDATE organizations
              SET billing_status = 'active',
                  past_due_since = NULL,
                  purge_after = NULL,
                  updated_at = ?
            WHERE id = ? AND billing_status = 'past_due'`
        )
        .bind(deps.now, org.id)
        .run();

      // Logged when it actually recovered somebody, because this is the write
      // that saves an account from deletion and its absence is invisible.
      if ((updated.meta?.changes ?? 0) > 0) {
        console.log(
          JSON.stringify({
            level: "info",
            message: "dunning cleared by successful payment",
            orgId: org.id,
            invoiceId: invoice.id,
          })
        );
      }
      return true;
    }

    default:
      // Acknowledged, not handled. Answering non-2xx here would make Stripe
      // retry an event we were never going to do anything with, and eventually
      // disable the endpoint.
      return false;
  }
}
