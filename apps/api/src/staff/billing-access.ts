/**
 * The billing screen — 32 PART 4 and 6 (Billing).
 *
 * ── Org-scoped, because that is what billing actually is ───────────────────
 * The design draws MRR as a column on the Workspaces table. That is the wrong
 * unit, not merely a missing field: `organizations.stripe_customer_id` is where
 * a subscription attaches, one billing account owns many workspaces, and a
 * per-workspace MRR would have to invent a split that nothing in the product
 * performs. So MRR lives here, per organization, and nowhere else.
 *
 * ── Read-only, on purpose ──────────────────────────────────────────────────
 * Nothing in this file mutates Stripe. Refunds, disputes and invoice edits
 * happen in Stripe's own dashboard, which is why every row carries a deep link
 * to the customer there. Rebuilding that surface here would mean reimplementing
 * a compliance-sensitive workflow with none of the controls Stripe already has.
 *
 * ── Card details are absent, and that is a product position ────────────────
 * The design shows a brand and last-4 column. We are deliberately outside PCI
 * scope: card data never touches our servers and we store nothing about it.
 * The column cannot be filled without starting to.
 *
 * ── A failed Stripe read is shown as unavailable, never as zero ────────────
 * `nextInvoiceAt` and `mrrCents` need a live Stripe call. When it fails the row
 * still renders with those two cells marked unavailable, because a blank reads
 * as "nothing due" and a zero reads as "not paying" - both of which are claims
 * about a customer's account that we would be making up.
 */

import { AuditedStaffAccess } from "./audited";
import type { Stripe } from "../billing/stripe";

export interface BillingOrgRow {
  orgId: string;
  orgName: string;
  ownerEmail: string | null;
  plan: string;
  billingStatus: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  workspaces: number;
  /** From the local plan catalogue. Null when the plan has no price here. */
  mrrCents: number | null;
  /** Unix ms from Stripe, or null when the read failed or there is no subscription. */
  nextInvoiceAt: number | null;
  /** True when Stripe could not be reached for this row. */
  stripeUnavailable: boolean;
}

export interface BillingSummary {
  orgs: number;
  pastDue: number;
  canceled: number;
  /** Sum of local plan prices for orgs whose billing is active. */
  mrrCents: number;
  /** True when any row's Stripe read failed, so the totals are partial. */
  partial: boolean;
}

export class StaffBillingAccess extends AuditedStaffAccess {
  /**
   * Every organization with a Stripe customer.
   *
   * The owner email comes from a LEFT JOIN, never an inner one. An inner join
   * here would make an organization whose owner row is missing vanish from the
   * billing screen entirely - and a past_due org that cannot be seen is exactly
   * the row somebody needs to find.
   */
  async list(
    stripe: Stripe | null,
    filter: "all" | "past_due" | "canceled" = "all"
  ): Promise<{ rows: BillingOrgRow[]; summary: BillingSummary }> {
    await this.requireRole("support", "read billing");

    const where =
      filter === "past_due"
        ? `AND o.billing_status = 'past_due'`
        : filter === "canceled"
          ? `AND o.billing_status IN ('canceled', 'cancelled')`
          : ``;

    const rows = await this.db
      .prepare(
        `SELECT o.id AS orgId, o.name AS orgName, u.email AS ownerEmail,
                o.plan, o.billing_status AS billingStatus,
                o.stripe_customer_id AS stripeCustomerId,
                o.stripe_subscription_id AS stripeSubscriptionId,
                (SELECT COUNT(*) FROM workspaces w
                  WHERE w.org_id = o.id AND w.status != 'deleted') AS workspaces,
                p.amount_cents AS mrrCents
           FROM organizations o
           LEFT JOIN users u ON u.id = o.owner_user_id
           LEFT JOIN plans p ON p.id = o.plan
          WHERE o.stripe_customer_id IS NOT NULL ${where}
          ORDER BY o.created_at DESC`
      )
      .all<Omit<BillingOrgRow, "nextInvoiceAt" | "stripeUnavailable">>();

    const list = rows.results ?? [];
    const out: BillingOrgRow[] = [];
    let partial = false;

    for (const row of list) {
      let nextInvoiceAt: number | null = null;
      let stripeUnavailable = false;

      if (stripe !== null && row.stripeSubscriptionId !== null) {
        try {
          const subscription = await stripe.subscriptions.retrieve(row.stripeSubscriptionId);
          const period = (subscription as { current_period_end?: number }).current_period_end;
          nextInvoiceAt = typeof period === "number" ? period * 1000 : null;
        } catch {
          // One failed row must not empty the screen. The cell is marked
          // unavailable and the rest of the table still renders.
          stripeUnavailable = true;
          partial = true;
        }
      } else if (row.stripeSubscriptionId !== null) {
        stripeUnavailable = true;
        partial = true;
      }

      out.push({ ...row, nextInvoiceAt, stripeUnavailable });
    }

    const summary: BillingSummary = {
      orgs: out.length,
      pastDue: out.filter(r => r.billingStatus === "past_due").length,
      canceled: out.filter(r => r.billingStatus === "canceled" || r.billingStatus === "cancelled")
        .length,
      mrrCents: out
        .filter(r => r.billingStatus === "active")
        .reduce((total, row) => total + (row.mrrCents ?? 0), 0),
      partial,
    };

    await this.recordFleet({
      action: "billing.view",
      metadata: { filter, orgs: out.length, partial },
    });

    return { rows: out, summary };
  }
}
