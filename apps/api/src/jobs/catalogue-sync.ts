/**
 * The plan catalogue, reconciled from Stripe on a schedule.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Until this job, `plans.stripe_price_id` was filled by exactly two things: a
 * `product.*` webhook, and an operator pressing Reconcile in the admin console.
 * Both are events. Neither happens in a freshly migrated environment, because
 * migration 0012 seeds the catalogue with NULL price ids and the products were
 * created in Stripe months earlier — so there is no webhook coming, and the
 * environment sits with every paid plan rendering as **"Not available"** until
 * somebody remembers a button.
 *
 * That is a bootstrap step disguised as an operational one, and asking the
 * owner to perform it is asking them to do the job this cron is for. A
 * catalogue that can be sold from is not a maintenance task; it is the product
 * working at all.
 *
 * ── It heals more than the bootstrap ──────────────────────────────────────
 * A `product.updated` delivery that Stripe retried into a 500, an edit made
 * directly in the Stripe dashboard while the Worker was mid-deploy, a price
 * minted before its product's webhook arrived — every one of those leaves the
 * catalogue quietly stale, and every one of them is invisible: the pricing
 * table renders, it is simply wrong. An hourly replay closes all of them
 * without anybody noticing they were open.
 *
 * ── Why `syncProductToPlan` and not the console's `syncFromStripe` ────────
 * They answer different questions. The console's version is a diff an operator
 * confirms field by field, because a one-click pull can bill real customers the
 * wrong amount — an admin editing a price locally and then pulling would
 * silently discard their edit.
 *
 * This is the *inbound* upsert, the same one the webhook runs, and it carries
 * no such hazard: Stripe is the record for price and product identity, and
 * replaying what Stripe says can only converge on what Stripe says. What it
 * must never do is write entitlements an operator set locally back to
 * something older — and it does not, because entitlements live in
 * `Product.metadata` and are pushed to Stripe first on every console edit.
 *
 * ── It needs no enable flag ───────────────────────────────────────────────
 * Unlike the three sweeps beside it in `scheduled()`, this destroys nothing.
 * The worst it can do is write the prices Stripe currently holds, which is the
 * state every other path is already trying to reach.
 */

import type { Stripe } from "../billing/stripe";
import { planIdOf, syncProductToPlan } from "../billing/plan-sync";

export interface CatalogueSyncResult {
  /** True when this deployment has no Stripe key and nothing was attempted. */
  skipped: boolean;
  /** Stripe products examined, including ones belonging to other product lines. */
  examined: number;
  /** Rows written — products carrying an `agentdisk-` package_id. */
  synced: number;
  /** Plans that now have at least one sellable price. */
  withPrice: number;
  /** Plans that are ours but still have no price at either cadence. */
  withoutPrice: string[];
  /** Products skipped because they belong to somebody else's catalogue. */
  foreign: number;
}

/**
 * Takes a client rather than a key, unlike the routes beside it.
 *
 * `admin/billing-access.ts` already works this way, for the reason that applies
 * here too: a job that builds its own client cannot be handed a stub, so the
 * only thing a test could reach would be the early return. Null is a real
 * state — a deployment with no Stripe key — and not a missing argument.
 */
export async function syncCatalogueFromStripe(
  db: D1Database,
  stripe: Stripe | null,
  now: number
): Promise<CatalogueSyncResult> {
  const result: CatalogueSyncResult = {
    skipped: false,
    examined: 0,
    synced: 0,
    withPrice: 0,
    withoutPrice: [],
    foreign: 0,
  };

  if (stripe === null) {
    // Not an error. A deployment without a Stripe key cannot sell anything and
    // has nothing to reconcile; saying so beats throwing on every tick.
    result.skipped = true;
    return result;
  }

  // Active only. An archived product's plan row is retired by the
  // `product.deleted` webhook, and re-syncing one here would resurrect a price
  // for a plan deliberately withdrawn from sale.
  const products = await stripe.products.list({ active: true, limit: 100 });
  result.examined = products.data.length;

  for (const product of products.data) {
    // The ownership test, before any work. This Stripe account also holds a
    // sibling product line, and `planIdOf` is what stops `amardrive-pro`
    // becoming a row in this product's entitlement table.
    if (planIdOf(product) === null) {
      result.foreign += 1;
      continue;
    }

    const upsert = await syncProductToPlan(db, stripe, product, now);
    if (upsert === null) continue;

    result.synced += 1;
    if (upsert.priceId !== null || upsert.yearlyPriceId !== null) {
      result.withPrice += 1;
    } else {
      // Named rather than counted. A plan of ours with no sellable price is the
      // one state an operator has to act on — the price has not been minted in
      // Stripe at all — and a count would not say which.
      result.withoutPrice.push(upsert.planId);
    }
  }

  return result;
}
