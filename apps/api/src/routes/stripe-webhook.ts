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
 */

import { ApiError } from "../lib/errors";
import { constructEvent, stripeClient, type Stripe } from "../billing/stripe";
import {
  applySubscriptionState,
  findOrgByCustomerId,
  findPlanByPriceId,
  type BillingStatus,
} from "../billing/organizations";

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
      await applySubscriptionState(
        deps.db,
        org.id,
        { plan: "free", billingStatus: "canceled", subscriptionId: null },
        deps.now
      );
      return true;
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
