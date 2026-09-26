/**
 * Stripe Product -> D1 `plans`.
 *
 * This is the upsert that the `product.*` webhook and the admin sync both call,
 * and the reason they share it is that a missed delivery, an edit made straight
 * in the Stripe dashboard and a manual reconcile must all heal identically.
 * Two implementations would drift, and the drift would surface only as
 * somebody's entitlements being quietly wrong.
 *
 * The Stripe client is stubbed rather than called. What is worth testing here is
 * the translation - metadata strings into the three column states, and which of
 * a product's prices counts as the sellable one - not Stripe's own list API.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { planIdOf, retirePlanForProduct, syncProductToPlan } from "../src/billing/plan-sync";
import {
  invalidateCatalogue,
  limitsForPlan,
  loadCatalogue,
} from "../src/billing/catalogue";
import { PLAN_LIMITS, UNLIMITED } from "../src/lib/plans";
import type { Stripe } from "../src/billing/stripe";

const NOW = 1_780_000_000_000;

/** A price as `prices.list` returns it. */
function price(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "price_monthly",
    object: "price",
    active: true,
    currency: "usd",
    unit_amount: 2000,
    recurring: { interval: "month", interval_count: 1 },
    ...overrides,
  };
}

function stripeStub(prices: unknown[]): Stripe {
  return {
    prices: { list: async () => ({ data: prices }) },
  } as unknown as Stripe;
}

function product(metadata: Record<string, string>, overrides: Record<string, unknown> = {}) {
  return {
    id: "prod_test",
    object: "product",
    name: "AgentDisk Pro",
    description: "Ten workspaces.",
    active: true,
    metadata,
    ...overrides,
  } as unknown as Stripe.Product;
}

const fullMetadata = {
  package_id: "agentdisk-pro",
  plan_id: "pro",
  storage_bytes: "53687091200",
  max_file_bytes: "1073741824",
  agents: "10",
  members: "5",
  workspaces: "10",
  api_keys: "20",
  egress_bytes_period: "unlimited",
  requests_period: "unlimited",
  file_count: "unlimited",
  priority_support: "1",
  is_default: "0",
  sort_order: "30",
};

async function planRow(id: string) {
  return env.DB.prepare(`SELECT * FROM plans WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM plans`).run();
  invalidateCatalogue();
});

describe("planIdOf", () => {
  it("prefers an explicit plan_id", () => {
    expect(planIdOf(product({ package_id: "agentdisk-pro", plan_id: "pro" }))).toBe("pro");
  });

  it("strips the agentdisk- prefix when there is no explicit id", () => {
    expect(planIdOf(product({ package_id: "agentdisk-team" }))).toBe("team");
  });

  it("refuses a product belonging to a different product line in the same account", () => {
    // Not hypothetical. The Stripe account this runs against also holds
    // amardrive's catalogue - four live products keyed `amardrive-*` - and the
    // earlier rule accepted any package_id, so a sync would have written plan
    // rows called "amardrive-pro" into this product's entitlement table.
    expect(planIdOf(product({ package_id: "amardrive-pro" }))).toBeNull();
    expect(planIdOf(product({ package_id: "amardrive-free" }))).toBeNull();

    // And plan_id cannot be used to claim one. It names a plan inside our
    // namespace; it does not confer membership of it.
    expect(planIdOf(product({ package_id: "amardrive-pro", plan_id: "pro" }))).toBeNull();
  });

  it("returns null for a product that is not ours", () => {
    // package_id is the join key. Without it the product belongs to somebody
    // else's purpose in the same Stripe account - a one-off charge, say - and
    // must never appear in the pricing table.
    expect(planIdOf(product({}))).toBeNull();
    expect(planIdOf(product({ package_id: "" }))).toBeNull();
  });
});

describe("syncProductToPlan", () => {
  it("writes the entitlements out of metadata", async () => {
    const result = await syncProductToPlan(
      env.DB,
      stripeStub([price()]),
      product(fullMetadata),
      NOW
    );
    expect(result).toEqual({
      planId: "pro",
      priceId: "price_monthly",
      yearlyPriceId: null,
    });

    const row = await planRow("pro");
    expect(row?.storage_bytes).toBe(53687091200);
    expect(row?.agents).toBe(10);
    expect(row?.workspaces).toBe(10);
    expect(row?.amount_cents).toBe(2000);
    expect(row?.stripe_product_id).toBe("prod_test");
    expect(row?.stripe_price_id).toBe("price_monthly");
    expect(row?.priority_support).toBe(1);
  });

  it("stores the literal unlimited as -1, which the resolver reads as no ceiling", async () => {
    await syncProductToPlan(env.DB, stripeStub([price()]), product(fullMetadata), NOW);

    const row = await planRow("pro");
    expect(row?.egress_bytes_period).toBe(-1);
    expect(row?.file_count).toBe(-1);

    invalidateCatalogue();
    const limits = limitsForPlan(await loadCatalogue(env.DB, NOW), null, "pro");
    expect(limits.egressBytesPerPeriod).toBe(UNLIMITED);
    expect(limits.fileCount).toBe(UNLIMITED);
  });

  it("stores an unreadable value as NULL, so it falls to the floor and not to zero", async () => {
    // The direction that matters. Reading a typo as 0 would set somebody's
    // storage limit to zero bytes and lock them out of their own account over a
    // misspelling; NULL means "this row did not say" and defers to the code.
    await syncProductToPlan(
      env.DB,
      stripeStub([price()]),
      product({ ...fullMetadata, storage_bytes: "fifty gigabytes", agents: "-4" }),
      NOW
    );

    const row = await planRow("pro");
    expect(row?.storage_bytes).toBeNull();
    expect(row?.agents).toBeNull();

    invalidateCatalogue();
    const limits = limitsForPlan(await loadCatalogue(env.DB, NOW), null, "pro");
    expect(limits.storageBytes).toBe(PLAN_LIMITS.pro.storageBytes);
    expect(limits.agents).toBe(PLAN_LIMITS.pro.agents);
  });

  it("ignores a product that carries no package_id", async () => {
    const result = await syncProductToPlan(env.DB, stripeStub([price()]), product({}), NOW);
    expect(result).toBeNull();
    expect((await loadCatalogue(env.DB, NOW)).size).toBe(0);
  });

  it("is idempotent — a redelivered webhook changes nothing", async () => {
    await syncProductToPlan(env.DB, stripeStub([price()]), product(fullMetadata), NOW);
    const first = await planRow("pro");

    await syncProductToPlan(env.DB, stripeStub([price()]), product(fullMetadata), NOW);
    expect(await planRow("pro")).toEqual(first);
  });

  it("takes one price per cadence, and ignores a one-off beside them", async () => {
    // **The price type and the checkout mode are one contract**, and this file
    // has now asserted both directions. It briefly required a one-time price,
    // while checkout was `mode: "payment"` under the two-day manual-renewal
    // design; a subscription needs a recurring price, and Stripe refuses a
    // one-time one in `mode: "subscription"` exactly as it refused the reverse.
    //
    // Both rules were right for their moment, which is why the pairing is worth
    // an explicit test rather than a comment.
    await syncProductToPlan(
      env.DB,
      stripeStub([
        price({ id: "price_once", recurring: null, unit_amount: 2000 }),
        price({
          id: "price_yearly",
          recurring: { interval: "year", interval_count: 1 },
          unit_amount: 20400,
        }),
        price({
          id: "price_monthly",
          recurring: { interval: "month", interval_count: 1 },
          unit_amount: 2000,
        }),
      ]),
      product({ package_id: "agentdisk-pro" }),
      NOW
    );

    const row = await planRow("pro");
    expect(row?.stripe_price_id).toBe("price_monthly");
    expect(row?.amount_cents).toBe(2000);
    expect(row?.stripe_yearly_price_id).toBe("price_yearly");
    expect(row?.amount_cents_yearly).toBe(20400);
  });

  it("ignores a cadence we do not sell, rather than reading it as one we do", async () => {
    // "Every three months" is a real monthly-interval price. Taking it as THE
    // monthly price would bill a quarter as a month — the customer pays once
    // and gets a quarter, or is charged quarterly for a plan sold as monthly,
    // depending on which way the mistake lands. `interval_count === 1` is the
    // guard, and it is the sort of thing only a test keeps.
    await syncProductToPlan(
      env.DB,
      stripeStub([
        price({
          id: "price_quarterly",
          recurring: { interval: "month", interval_count: 3 },
          unit_amount: 5400,
        }),
      ]),
      product({ package_id: "agentdisk-pro" }),
      NOW
    );

    expect((await planRow("pro"))?.stripe_price_id).toBeNull();
  });

  it("records no price at all rather than one that cannot be charged", async () => {
    // A product carrying only a one-off price, which cannot be subscribed to.
    //
    // Null is the right answer: `purchasablePlans` drops a plan without a price
    // and the dashboard renders it unavailable, which is visible and correct.
    // Falling back to the unusable price would be invisible and broken — a
    // button whose only outcome is a Stripe error.
    await syncProductToPlan(
      env.DB,
      stripeStub([price({ id: "price_once", recurring: null })]),
      product({ package_id: "agentdisk-pro" }),
      NOW
    );

    expect((await planRow("pro"))?.stripe_price_id).toBeNull();
  });

  it("sells a plan monthly only, when that is all Stripe carries", async () => {
    // Yearly is optional per plan, not a second half that must always exist.
    await syncProductToPlan(
      env.DB,
      stripeStub([price({ id: "price_monthly" })]),
      product({ package_id: "agentdisk-pro" }),
      NOW
    );

    const row = await planRow("pro");
    expect(row?.stripe_price_id).toBe("price_monthly");
    expect(row?.stripe_yearly_price_id).toBeNull();
    expect(row?.amount_cents_yearly).toBeNull();
  });

  it("records a product that has no price yet", async () => {
    // The ordinary state right after `terraform apply`: Terraform creates the
    // product first, so product.created usually arrives before its price
    // exists. The row lands, the price follows on the next sync, and checkout
    // refuses the plan in the meantime rather than assuming one.
    const result = await syncProductToPlan(env.DB, stripeStub([]), product(fullMetadata), NOW);
    expect(result).toEqual({ planId: "pro", priceId: null, yearlyPriceId: null });
    expect((await planRow("pro"))?.stripe_price_id).toBeNull();
  });

  it("marks an archived product unsellable but keeps its row", async () => {
    await syncProductToPlan(
      env.DB,
      stripeStub([price()]),
      product(fullMetadata, { active: false }),
      NOW
    );
    const row = await planRow("pro");
    expect(row?.is_public).toBe(0);
    expect(row).not.toBeNull();
  });
});

describe("retirePlanForProduct", () => {
  beforeEach(async () => {
    await syncProductToPlan(
      env.DB,
      stripeStub([price()]),
      product({ ...fullMetadata, is_default: "1" }),
      NOW
    );
  });

  it("retires the plan without deleting the row", async () => {
    // The row is what resolves a subscription's price back to entitlements.
    // Deleting it would silently drop everybody still on that plan to the
    // default - the opposite of what retiring a plan is supposed to mean.
    expect(await retirePlanForProduct(env.DB, product(fullMetadata), NOW)).toBe("pro");

    const row = await planRow("pro");
    expect(row).not.toBeNull();
    expect(row?.is_public).toBe(0);
    expect(row?.stripe_price_id).toBeNull();
    expect(row?.storage_bytes).toBe(53687091200);
  });

  it("clears is_default, so a retired plan is not where new accounts land", async () => {
    await retirePlanForProduct(env.DB, product(fullMetadata), NOW);
    expect((await planRow("pro"))?.is_default).toBe(0);
  });

  it("ignores a product that is not ours", async () => {
    expect(await retirePlanForProduct(env.DB, product({}), NOW)).toBeNull();
  });
});

/**
 * The sync stamp.
 *
 * `last_synced_at` is what the Plans screen renders as "synced 14:02". It was
 * written only by the console's own edit paths, never by this function - which
 * is the one BOTH the `product.*` webhook and the admin "Reconcile all" run
 * through. So the column stayed NULL however many times somebody synced, and
 * the screen said "not synced" permanently.
 *
 * A status that cannot change is worse than no status at all: it reads as a
 * problem to go and chase.
 */
describe("the sync stamp", () => {
  it("records when a sync happened, and which way it went", async () => {
    await syncProductToPlan(env.DB, stripeStub([price()]), product(fullMetadata), NOW);

    const row = await planRow("pro");
    expect(row?.last_synced_at).toBe(NOW);
    // Inbound: a webhook and a reconcile are both Stripe telling us something.
    // 'outbound' belongs to a push from the console.
    expect(row?.last_synced_direction).toBe("inbound");
  });

  it("moves the stamp forward on a re-sync", async () => {
    await syncProductToPlan(env.DB, stripeStub([price()]), product(fullMetadata), NOW);
    await syncProductToPlan(env.DB, stripeStub([price()]), product(fullMetadata), NOW + 60_000);

    expect((await planRow("pro"))?.last_synced_at).toBe(NOW + 60_000);
  });
});
