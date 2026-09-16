/**
 * Billing — 14 PART 29.1/29.3.
 *
 * Portal depth, deliberately: AgentDisk creates the Stripe Customer and hands
 * the person to Stripe's own hosted portal for everything after that. No card
 * form, no plan-change UI, no invoice list of our own. That is not laziness —
 * every one of those screens is a PCI surface and a thing to keep in step with
 * Stripe's own behaviour, and none of them makes the product better at storing
 * files for agents.
 */

import { ApiError, forbidden } from "../lib/errors";
import { stripeClient } from "../billing/stripe";
import {
  attachStripeCustomer,
  findOrgForWorkspace,
  type OrgBilling,
} from "../billing/organizations";
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
}

/** What the Billing screen renders. Safe for any member to read. */
export async function getBilling(ctx: AuthContext, deps: BillingDeps): Promise<Response> {
  const org = await findOrgForWorkspace(deps.db, ctx.workspaceId);
  if (org === null) throw new ApiError("NOT_FOUND", "No billing account for this workspace.");

  return json({
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
    },
  });
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
