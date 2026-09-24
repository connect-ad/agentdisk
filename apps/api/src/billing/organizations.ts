/**
 * The organization behind a workspace: its plan, its Stripe customer, and
 * whether it is paid up — 14 PART 29.2/29.4.
 *
 * Organizations sit above workspaces, so none of this can be workspace-scoped.
 * Every function takes the workspace and resolves upward, which keeps the same
 * property the scoped repositories have: a caller cannot name an organization
 * it does not reach through a workspace it was already authorized for.
 */

import { isBillingInterval, type BillingInterval } from "../lib/renewal";

/**
 * The four states an account's billing can be in, and the order they happen in.
 *
 *   active    paying, or free and never having paid. Writes allowed.
 *   past_due  a renewal charge failed and Stripe is retrying. Writes blocked,
 *             reads open. This is the grace window, and it is the SAME seven
 *             days as Stripe's dunning — see `lib/renewal.ts`.
 *   expired   Stripe gave up collecting. Writes blocked, deletion scheduled.
 *   canceled  the customer ended it themselves, or the subscription was
 *             deleted outright. Drops to free.
 *
 * `expired` arrived with manual renewal in migration 0027 and survives the
 * return to auto-renewal, because the state it names still exists: an account
 * that stopped paying and is counting down to deletion. What changed is how it
 * is reached — no longer "nobody bought another month" but "dunning ran out".
 */
export type BillingStatus = "active" | "past_due" | "canceled" | "expired";

export interface OrgBilling {
  id: string;
  name: string;
  plan: string;
  billingStatus: BillingStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  ownerEmail: string;
  /**
   * When the paid period runs out — a MIRROR of Stripe's
   * `subscription.current_period_end` since migration 0029, not a value this
   * product computes. NULL means nothing was ever bought — every free account —
   * which is not the same as expired and must not be read as it.
   */
  currentPeriodEnd: number | null;
  /** 'month' | 'year' | null. Null is an account with no subscription. */
  billingInterval: BillingInterval | null;
  /**
   * Whether the live subscription stops at the end of the paid period.
   *
   * Independent of `billingStatus`: a cancelling subscription is still `active`
   * and still entitled to everything it bought until the date arrives. This is
   * the whole difference between "Renews 24 October" and "Ends 24 October".
   */
  cancelAtPeriodEnd: boolean;
  /** When the current run of failed charges began. NULL means not in dunning. */
  pastDueSince: number | null;
  /** When this account's data is scheduled for deletion. NULL means not queued. */
  purgeAfter: number | null;
}

function asStatus(value: string): BillingStatus {
  // Anything unrecognised is treated as active rather than blocking: a typo in
  // this column must not lock a paying customer out of their own product. The
  // failure mode of guessing wrong in the other direction is far worse than a
  // few requests we should have refused.
  return value === "past_due" || value === "canceled" || value === "expired" ? value : "active";
}

export async function findOrgForWorkspace(
  db: D1Database,
  workspaceId: string
): Promise<OrgBilling | null> {
  const row = await db
    .prepare(
      `SELECT o.id, o.name, o.plan, o.billing_status AS billingStatus,
              o.stripe_customer_id AS stripeCustomerId,
              o.stripe_subscription_id AS stripeSubscriptionId,
              o.current_period_end AS currentPeriodEnd,
              o.billing_interval AS billingInterval,
              o.cancel_at_period_end AS cancelAtPeriodEnd,
              o.past_due_since AS pastDueSince,
              o.purge_after AS purgeAfter,
              u.email AS ownerEmail
         FROM organizations o
         JOIN workspaces w ON w.org_id = o.id
         JOIN users u ON u.id = o.owner_user_id
        WHERE w.id = ?`
    )
    .bind(workspaceId)
    .first<
      Omit<OrgBilling, "billingStatus" | "billingInterval" | "cancelAtPeriodEnd"> & {
        billingStatus: string;
        billingInterval: string | null;
        cancelAtPeriodEnd: number;
      }
    >();

  if (row === null) return null;
  return {
    ...row,
    billingStatus: asStatus(row.billingStatus),
    billingInterval: isBillingInterval(row.billingInterval) ? row.billingInterval : null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd === 1,
  };
}

export async function findOrgByCustomerId(
  db: D1Database,
  customerId: string
): Promise<OrgRef | null> {
  return db
    .prepare(
      `SELECT id, plan, current_period_end AS currentPeriodEnd,
              past_due_since AS pastDueSince, billing_status AS billingStatus
         FROM organizations WHERE stripe_customer_id = ?`
    )
    .bind(customerId)
    .first<OrgRef>();
}

/**
 * What a webhook handler needs about an organization, and no more.
 *
 * `pastDueSince` is here because the deletion schedule is anchored on it: a
 * handler that clears or preserves dunning has to know whether a run is already
 * open, or a redelivered `invoice.payment_failed` would restart the customer's
 * grace from zero and buy them another week on every retry.
 */
export interface OrgRef {
  id: string;
  plan: string;
  currentPeriodEnd: number | null;
  pastDueSince: number | null;
  billingStatus: string;
}

export async function attachStripeCustomer(
  db: D1Database,
  orgId: string,
  customerId: string,
  now: number
): Promise<void> {
  // Guarded on the column still being empty so two concurrent portal requests
  // cannot overwrite each other and strand a customer object nothing points at.
  await db
    .prepare(
      `UPDATE organizations SET stripe_customer_id = ?, updated_at = ?
        WHERE id = ? AND stripe_customer_id IS NULL`
    )
    .bind(customerId, now, orgId)
    .run();
}

export async function applySubscriptionState(
  db: D1Database,
  orgId: string,
  changes: {
    plan?: string;
    billingStatus?: BillingStatus;
    subscriptionId?: string | null;
    /** The new paid-through moment. Only a completed payment moves this. */
    currentPeriodEnd?: number | null;
    /**
     * The deletion stamp. Passing `null` is the important direction: a renewal
     * has to clear a schedule an earlier sweep already wrote, or somebody who
     * paid on day ten is deleted anyway.
     */
    purgeAfter?: number | null;
    /** Which cadence the live subscription bills at. */
    billingInterval?: BillingInterval | null;
    /** Whether it stops at the end of the paid period. */
    cancelAtPeriodEnd?: boolean;
    /**
     * When the current dunning run began. `null` clears it, and that is the
     * direction that matters: a successful payment has to close the run, or the
     * scheduling pass goes on counting from a failure that was already resolved.
     */
    pastDueSince?: number | null;
  },
  now: number
): Promise<void> {
  const sets: string[] = ["updated_at = ?"];
  const values: (string | number | null)[] = [now];

  if (changes.plan !== undefined) { sets.push("plan = ?"); values.push(changes.plan); }
  if (changes.billingStatus !== undefined) {
    sets.push("billing_status = ?");
    values.push(changes.billingStatus);
  }
  if (changes.subscriptionId !== undefined) {
    sets.push("stripe_subscription_id = ?");
    values.push(changes.subscriptionId);
  }
  if (changes.currentPeriodEnd !== undefined) {
    sets.push("current_period_end = ?");
    values.push(changes.currentPeriodEnd);
  }
  if (changes.purgeAfter !== undefined) {
    sets.push("purge_after = ?");
    values.push(changes.purgeAfter);
  }
  if (changes.billingInterval !== undefined) {
    sets.push("billing_interval = ?");
    values.push(changes.billingInterval);
  }
  if (changes.cancelAtPeriodEnd !== undefined) {
    sets.push("cancel_at_period_end = ?");
    values.push(changes.cancelAtPeriodEnd ? 1 : 0);
  }
  if (changes.pastDueSince !== undefined) {
    sets.push("past_due_since = ?");
    values.push(changes.pastDueSince);
  }

  await db
    .prepare(`UPDATE organizations SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values, orgId)
    .run();
}

/**
 * Is this account paying for service right now?
 *
 * ── Why this exists as one function ────────────────────────────────────────
 * Two places needed the answer and both wrote it as *"not cancelled"*:
 * `admin/users-access.ts`, gating whether an account can be deleted, and
 * `jobs/admin-purge.ts`, gating whether it can be swept. Adding `expired` in
 * migration 0027 broke both in the same direction — an expired account is not
 * `canceled`, so both read it as a **paying customer** and refused to touch it.
 *
 * The result was an account that had stopped paying and could not be removed by
 * any route: the console refused with *"Cancel it in Stripe before deleting the
 * account"* — for a subscription that does not exist and cannot be cancelled —
 * and the purge job logged *"skipped: live billing"* forever.
 *
 * The rule that survives it: **check against the one good state, never against
 * the list of bad ones.** Every site written `status !== 'active'` came through
 * that migration untouched; every site written `status !== 'canceled'` broke.
 * A list of bad states is a list that grows.
 *
 * Free accounts are correctly false here: `active` with no period is somebody
 * who has never bought anything, not somebody mid-subscription.
 */
export function isPayingNow(
  org: { billingStatus: string; currentPeriodEnd: number | null },
  now: number
): boolean {
  return (
    org.billingStatus === "active" &&
    org.currentPeriodEnd !== null &&
    org.currentPeriodEnd > now
  );
}

/**
 * Resolve a Stripe price back to one of our plans, and to the cadence it sells
 * that plan at (29.6).
 *
 * Both columns are searched because a plan has two prices since migration 0029.
 * Looking only at `stripe_price_id` — which is what this did — would leave every
 * yearly subscriber's `customer.subscription.updated` resolving to no plan at
 * all, and the handler's deliberate "undefined rather than a guess" rule would
 * then quietly leave them on whatever plan they had before.
 *
 * The interval comes back with the id because the webhook is the only place
 * that learns which cadence a subscription actually bills at; the subscription
 * object carries the price, and the price is what this maps.
 */
export async function findPlanByPriceId(
  db: D1Database,
  priceId: string
): Promise<{ id: string; interval: BillingInterval } | null> {
  const row = await db
    .prepare(
      `SELECT id,
              CASE WHEN stripe_yearly_price_id = ?1 THEN 'year' ELSE 'month' END AS interval
         FROM plans
        WHERE stripe_price_id = ?1 OR stripe_yearly_price_id = ?1`
    )
    .bind(priceId)
    .first<{ id: string; interval: string }>();

  if (row === null) return null;
  return {
    id: row.id,
    interval: isBillingInterval(row.interval) ? row.interval : "month",
  };
}
