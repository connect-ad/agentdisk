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
 *   checkout.session.completed      ** a month was paid for — see below
 *   product.created                  *   product.updated                  | the catalogue, mirrored into D1
 *   product.deleted                 /
 *   charge.refunded                 recorded, entitlements deliberately untouched
 *   customer.subscription.created    *   customer.subscription.updated    | dormant — see below
 *   customer.subscription.deleted   /
 *   invoice.payment_failed          dormant
 *   invoice.payment_succeeded       dormant
 *
 * ── Which of them actually fire ─────────────────────────────────────────────
 * Since AgentDisk stopped auto-renewing (23 September 2026) checkout creates a
 * one-off **payment**, not a subscription. So `checkout.session.completed` is
 * the only event that grants service, and it now settles everything a purchase
 * means: the plan, the paid-through date, and the cancellation of any deletion
 * already scheduled. It used to be the thin half of a pair.
 *
 * The six marked dormant cannot be reached by anything this product creates —
 * there is no subscription to have a lifecycle and no invoice to fail. They are
 * kept, subscribed and working because a subscription made by hand in the
 * Stripe dashboard still arrives here, and because deleting them would turn
 * "return to auto-renewal" from a decision into a rewrite. Do not mistake their
 * silence for dead code.
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
} from "../billing/organizations";
import { retirePlanForProduct, syncProductToPlan } from "../billing/plan-sync";
import { nextPeriodEnd } from "../lib/renewal";

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

/** Which of our plans a subscription is on, from the price it carries. */
async function planFromSubscription(
  db: D1Database,
  subscription: Stripe.Subscription
): Promise<string | undefined> {
  const priceId = subscription.items.data[0]?.price?.id;
  if (priceId === undefined) return undefined;
  const plan = await findPlanByPriceId(db, priceId);
  // Undefined rather than a guess. Leaving the plan alone is safer than
  // resolving an unknown price to something arbitrary - one direction keeps
  // billing and entitlement in step, the other silently upgrades or downgrades
  // somebody because a price was renamed in Stripe.
  return plan?.id;
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

/** What every handler here needs about an organization, and no more. */
interface OrgRef {
  id: string;
  plan: string;
  currentPeriodEnd: number | null;
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
      `SELECT id, plan, current_period_end AS currentPeriodEnd
         FROM organizations WHERE id = ?`
    )
    .bind(orgId)
    .first<OrgRef>();
}

/**
 * The plan a completed one-off purchase was for.
 *
 * Read from the session metadata this product wrote at checkout, then checked
 * against `plans` rather than trusted. The value arrives inside a signed event
 * so it is not forgeable, but it is still a string we put into Stripe — a plan
 * can have been retired since, and writing an id no row describes would leave
 * the account's entitlements resolving to the Free floor with no way to tell
 * why.
 *
 * Undefined rather than a guess, on the same reasoning as
 * `planFromSubscription`: leaving the plan alone beats resolving an unknown to
 * something arbitrary.
 */
async function planFromSession(
  db: D1Database,
  session: Stripe.Checkout.Session
): Promise<string | undefined> {
  const claimed = session.metadata?.["agentdisk_plan"];
  if (claimed === undefined || claimed === "") return undefined;

  const row = await db
    .prepare(`SELECT id FROM plans WHERE id = ?`)
    .bind(claimed)
    .first<{ id: string }>();
  return row?.id;
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
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = customerIdOf(subscription.customer);
      if (customerId === null) return false;

      const org = await findOrgByCustomerId(deps.db, customerId);
      if (org === null) return false;

      await applySubscriptionState(
        deps.db,
        org.id,
        {
          plan: await planFromSubscription(deps.db, subscription),
          billingStatus: statusFrom(subscription),
          subscriptionId: subscription.id,
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

      // The plan drops to free rather than staying on the paid one it was.
      // Leaving it would keep enforcing a paid quota for somebody who has
      // stopped paying, which is the wrong direction to be generous in.
      //
      // `currentPeriodEnd` is cleared with it. The period was that
      // subscription's; leaving it behind would have the renewal job counting
      // down to an expiry for service that has already stopped, and would make
      // the dashboard promise a date nothing will honour.
      await applySubscriptionState(
        deps.db,
        org.id,
        {
          plan: "free",
          billingStatus: "canceled",
          subscriptionId: null,
          currentPeriodEnd: null,
        },
        deps.now
      );
      return true;
    }

    case "checkout.session.completed": {
      // The moment a month is actually paid for, and under manual renewal this
      // is now the ONLY event that grants service. There is no subscription
      // behind it to carry the plan in a later event, so everything the
      // purchase means is settled here: which plan, paid through when, and the
      // cancellation of any deletion already scheduled.
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

      if (session.mode === "subscription") {
        // A subscription checkout, which this product no longer creates. Kept
        // because a subscription made by hand in the Stripe dashboard still
        // arrives here, and recording which subscription belongs to which
        // organization is the right response. The plan is left to the
        // customer.subscription.* events, which carry the price.
        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : (session.subscription?.id ?? null);
        if (subscriptionId === null) return false;

        await applySubscriptionState(
          deps.db,
          org.id,
          { billingStatus: "active", subscriptionId },
          deps.now
        );
        return true;
      }

      if (session.mode !== "payment") return false;

      // A completed session is not a paid one. Some payment methods settle
      // asynchronously, and Stripe fires this event with `payment_status`
      // still `unpaid` while it waits — granting a month there would hand out
      // service for a charge that may yet fail.
      if (session.payment_status !== "paid") return false;

      const plan = await planFromSession(deps.db, session);
      if (plan === undefined) return false;

      // Extends from the existing period end when one is still live, so
      // renewing early on the strength of the day-seven reminder adds a month
      // rather than discarding the days already paid for.
      const periodEnd = nextPeriodEnd(deps.now, org.currentPeriodEnd);

      await applySubscriptionState(
        deps.db,
        org.id,
        {
          plan,
          billingStatus: "active",
          currentPeriodEnd: periodEnd,
          // The single most important write in this feature. A sweep may
          // already have stamped this account for deletion during the grace
          // window; paying has to take it back, or somebody who renewed on day
          // ten is deleted anyway by a job that ran on day seven.
          purgeAfter: null,
        },
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
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = customerIdOf(invoice.customer);
      if (customerId === null) return false;

      const org = await findOrgByCustomerId(deps.db, customerId);
      if (org === null) return false;

      // Writes stop; reads keep working. Somebody whose card expired must still
      // be able to get their data out.
      await applySubscriptionState(deps.db, org.id, { billingStatus: "past_due" }, deps.now);
      return true;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = customerIdOf(invoice.customer);
      if (customerId === null) return false;

      const org = await findOrgByCustomerId(deps.db, customerId);
      if (org === null) return false;

      // Only lifts `past_due`. A payment succeeding on a canceled subscription
      // does not un-cancel it - that is what a new subscription event is for,
      // and quietly reactivating here would restore access somebody deliberately
      // gave up.
      if (org.plan !== undefined) {
        await deps.db
          .prepare(
            `UPDATE organizations SET billing_status = 'active', updated_at = ?
              WHERE id = ? AND billing_status = 'past_due'`
          )
          .bind(deps.now, org.id)
          .run();
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
