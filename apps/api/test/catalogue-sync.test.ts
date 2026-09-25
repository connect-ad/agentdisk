/**
 * The hourly catalogue reconcile — `jobs/catalogue-sync.ts`.
 *
 * This job exists because the catalogue had two writers and both were events: a
 * `product.*` webhook, and an operator pressing Reconcile in the console.
 * Neither fires in a freshly migrated environment — migration 0012 seeds NULL
 * price ids and the products were created in Stripe months earlier — so every
 * paid plan rendered as **"Not available"** until somebody remembered a button.
 *
 * The first test is that bootstrap, because it is the failure this job was
 * written for and the one nothing else in the suite covers. The per-product
 * upsert it replays is `plan-sync.test.ts`'s subject and is not re-asserted
 * here; what these tests own is what the *job* decides — which products it
 * walks, which it refuses, and what it reports back.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { syncCatalogueFromStripe } from "../src/jobs/catalogue-sync";
import { invalidateCatalogue } from "../src/billing/catalogue";
import type { Stripe } from "../src/billing/stripe";
import { NOW } from "./helpers";

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

function product(
  id: string,
  metadata: Record<string, string>,
  overrides: Record<string, unknown> = {}
): unknown {
  return {
    id,
    object: "product",
    name: `AgentDisk ${metadata["plan_id"] ?? "Plan"}`,
    description: null,
    active: true,
    metadata,
    ...overrides,
  };
}

/**
 * Stripe, stubbed at `products.list` and `prices.list`.
 *
 * `prices.list` answers per product rather than returning one fixed list. The
 * whole point of this job is that it walks several products and each carries
 * its own prices; a stub that ignored the `product` filter would pass while
 * giving every plan the same price id, which is precisely the bug it would need
 * to catch.
 */
function stripeStub(
  products: unknown[],
  pricesByProduct: Record<string, unknown[]> = {}
): Stripe {
  return {
    products: { list: async () => ({ data: products }) },
    prices: {
      list: async (params: { product?: string }) => ({
        data: params.product === undefined ? [] : (pricesByProduct[params.product] ?? []),
      }),
    },
  } as unknown as Stripe;
}

async function planRow(id: string) {
  return env.DB.prepare(`SELECT * FROM plans WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM plans`).run();
  invalidateCatalogue();
});

describe("the bootstrap this job exists for", () => {
  it("fills an empty catalogue with no webhook and nobody pressing anything", async () => {
    // The exact state of a freshly migrated environment: products live in
    // Stripe from months ago, `plans` has NULL price ids, and no `product.*`
    // event is ever coming because nothing in Stripe has changed. Before this
    // job the only way out was an operator remembering Console → Plans →
    // Reconcile, which is a bootstrap step wearing an operational disguise.
    const stripe = stripeStub(
      [
        product("prod_basic", { package_id: "agentdisk-basic", plan_id: "basic" }),
        product("prod_pro", { package_id: "agentdisk-pro", plan_id: "pro" }),
      ],
      {
        prod_basic: [price({ id: "price_basic", unit_amount: 900 })],
        prod_pro: [
          price({ id: "price_pro", unit_amount: 2000 }),
          price({
            id: "price_pro_year",
            unit_amount: 20400,
            recurring: { interval: "year", interval_count: 1 },
          }),
        ],
      }
    );

    const result = await syncCatalogueFromStripe(env.DB, stripe, NOW);

    expect(result.synced).toBe(2);
    expect(result.withPrice).toBe(2);
    expect(result.withoutPrice).toEqual([]);

    expect((await planRow("basic"))?.stripe_price_id).toBe("price_basic");
    const pro = await planRow("pro");
    expect(pro?.stripe_price_id).toBe("price_pro");
    expect(pro?.stripe_yearly_price_id).toBe("price_pro_year");
    expect(pro?.amount_cents_yearly).toBe(20400);
  });

  it("gives each plan its own product's price, not the first one it saw", async () => {
    // A stub ignoring the `product` filter would pass a laxer test while every
    // plan silently took Basic's price — and the symptom in production is
    // somebody being charged $9 for Pro.
    const stripe = stripeStub(
      [
        product("prod_basic", { package_id: "agentdisk-basic", plan_id: "basic" }),
        product("prod_team", { package_id: "agentdisk-team", plan_id: "team" }),
      ],
      {
        prod_basic: [price({ id: "price_basic", unit_amount: 900 })],
        prod_team: [price({ id: "price_team", unit_amount: 8000 })],
      }
    );

    await syncCatalogueFromStripe(env.DB, stripe, NOW);

    expect((await planRow("basic"))?.amount_cents).toBe(900);
    expect((await planRow("team"))?.amount_cents).toBe(8000);
  });
});

describe("what it refuses", () => {
  it("does nothing, and says so, when this deployment has no Stripe key", async () => {
    // Not an error. A deployment without a key cannot sell anything and has
    // nothing to reconcile; throwing on every hourly tick would be noise in the
    // log that somebody eventually learns to ignore.
    const result = await syncCatalogueFromStripe(env.DB, null, NOW);

    expect(result.skipped).toBe(true);
    expect(result.synced).toBe(0);
    expect(result.examined).toBe(0);
  });

  it("leaves another product line's catalogue alone", async () => {
    // Not hypothetical. This Stripe account also holds amardrive's four
    // products, and an hourly job that took them would write `amardrive-pro`
    // into this product's entitlement table — where the Plans screen would
    // offer it for sale.
    const stripe = stripeStub(
      [
        product("prod_ours", { package_id: "agentdisk-pro", plan_id: "pro" }),
        product("prod_theirs", { package_id: "amardrive-pro", plan_id: "pro" }),
        product("prod_stray", {}),
      ],
      {
        prod_ours: [price({ id: "price_ours" })],
        prod_theirs: [price({ id: "price_theirs", unit_amount: 149 })],
      }
    );

    const result = await syncCatalogueFromStripe(env.DB, stripe, NOW);

    expect(result.examined).toBe(3);
    expect(result.synced).toBe(1);
    expect(result.foreign).toBe(2);
    // Ours won, and theirs never reached the table — including the one whose
    // `plan_id` also said "pro", which is the collision that would matter.
    expect((await planRow("pro"))?.stripe_price_id).toBe("price_ours");
  });
});

describe("what it reports", () => {
  it("names a plan Stripe holds no sellable price for, rather than counting it", async () => {
    // The one state an operator actually has to act on: the product exists but
    // no price was ever minted, so the plan renders as unavailable and no
    // amount of syncing will change that. A count would say "one plan is
    // unsellable" without saying which, and the next move needs the name.
    // It is also why the cron logs this run at `warn` when the list is
    // non-empty and `info` when it is not.
    const stripe = stripeStub(
      [
        product("prod_pro", { package_id: "agentdisk-pro", plan_id: "pro" }),
        product("prod_team", { package_id: "agentdisk-team", plan_id: "team" }),
      ],
      { prod_pro: [price({ id: "price_pro" })] }
    );

    const result = await syncCatalogueFromStripe(env.DB, stripe, NOW);

    expect(result.synced).toBe(2);
    expect(result.withPrice).toBe(1);
    expect(result.withoutPrice).toEqual(["team"]);
  });

  it("is idempotent — an hourly replay changes nothing", async () => {
    // It runs every hour forever. If a second pass differed from the first,
    // every plan row's `updated_at` would churn and the console's "last synced"
    // would be meaningless.
    const stripe = stripeStub([product("prod_pro", { package_id: "agentdisk-pro", plan_id: "pro" })], {
      prod_pro: [price({ id: "price_pro" })],
    });

    await syncCatalogueFromStripe(env.DB, stripe, NOW);
    const first = await planRow("pro");

    await syncCatalogueFromStripe(env.DB, stripe, NOW);
    expect(await planRow("pro")).toEqual(first);
  });

  it("does not resurrect a price for a plan withdrawn from sale", async () => {
    // `products.list` is filtered to active. An archived product's row is
    // retired by the `product.deleted` webhook, and re-syncing it here would
    // put a withdrawn plan back on the pricing page every hour.
    const stripe = stripeStub([], {});
    const result = await syncCatalogueFromStripe(env.DB, stripe, NOW);

    expect(result.examined).toBe(0);
    expect(result.synced).toBe(0);
  });
});
