/**
 * The organization behind a workspace: its plan, its Stripe customer, and
 * whether it is paid up — 14 PART 29.2/29.4.
 *
 * Organizations sit above workspaces, so none of this can be workspace-scoped.
 * Every function takes the workspace and resolves upward, which keeps the same
 * property the scoped repositories have: a caller cannot name an organization
 * it does not reach through a workspace it was already authorized for.
 */

/**
 * `expired` is the state manual renewal actually produces — a period that ran
 * out with nobody buying another. `past_due` and `canceled` belong to the
 * subscription model and are no longer reachable through checkout, because a
 * one-off payment has no invoice to fail and no subscription to cancel. They
 * are kept because their handlers are kept: a Stripe account can still emit
 * those events for a subscription created by hand, and answering them by
 * blocking writes is the right response either way.
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
   * When the paid period runs out. NULL means nothing was ever bought — every
   * free account — which is not the same as expired and must not be read as it.
   */
  currentPeriodEnd: number | null;
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
              o.purge_after AS purgeAfter,
              u.email AS ownerEmail
         FROM organizations o
         JOIN workspaces w ON w.org_id = o.id
         JOIN users u ON u.id = o.owner_user_id
        WHERE w.id = ?`
    )
    .bind(workspaceId)
    .first<Omit<OrgBilling, "billingStatus"> & { billingStatus: string }>();

  if (row === null) return null;
  return { ...row, billingStatus: asStatus(row.billingStatus) };
}

export async function findOrgByCustomerId(
  db: D1Database,
  customerId: string
): Promise<{ id: string; plan: string; currentPeriodEnd: number | null } | null> {
  return db
    .prepare(
      `SELECT id, plan, current_period_end AS currentPeriodEnd
         FROM organizations WHERE stripe_customer_id = ?`
    )
    .bind(customerId)
    .first<{ id: string; plan: string; currentPeriodEnd: number | null }>();
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

/** Resolve a Stripe price back to one of our plans (29.6). */
export async function findPlanByPriceId(
  db: D1Database,
  priceId: string
): Promise<{ id: string } | null> {
  return db
    .prepare(`SELECT id FROM plans WHERE stripe_price_id = ?`)
    .bind(priceId)
    .first<{ id: string }>();
}
