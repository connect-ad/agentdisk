/**
 * The organization behind a workspace: its plan, its Stripe customer, and
 * whether it is paid up — 14 PART 29.2/29.4.
 *
 * Organizations sit above workspaces, so none of this can be workspace-scoped.
 * Every function takes the workspace and resolves upward, which keeps the same
 * property the scoped repositories have: a caller cannot name an organization
 * it does not reach through a workspace it was already authorized for.
 */

export type BillingStatus = "active" | "past_due" | "canceled";

export interface OrgBilling {
  id: string;
  name: string;
  plan: string;
  billingStatus: BillingStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  ownerEmail: string;
}

function asStatus(value: string): BillingStatus {
  // Anything unrecognised is treated as active rather than blocking: a typo in
  // this column must not lock a paying customer out of their own product. The
  // failure mode of guessing wrong in the other direction is far worse than a
  // few requests we should have refused.
  return value === "past_due" || value === "canceled" ? value : "active";
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
): Promise<{ id: string; plan: string } | null> {
  return db
    .prepare(`SELECT id, plan FROM organizations WHERE stripe_customer_id = ?`)
    .bind(customerId)
    .first<{ id: string; plan: string }>();
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
  changes: { plan?: string; billingStatus?: BillingStatus; subscriptionId?: string | null },
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

  await db
    .prepare(`UPDATE organizations SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values, orgId)
    .run();
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
