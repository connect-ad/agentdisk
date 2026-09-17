/**
 * Stripe Product -> D1 `plans`.
 *
 * This is the upsert that the `product.*` webhook and the staff sync both call,
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
    recurring: { interval: "month" },
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
    expect(result).toEqual({ planId: "pro", priceId: "price_monthly" });

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

  it("picks the monthly recurring price out of several", async () => {
    await syncProductToPlan(
      env.DB,
      stripeStub([
        price({ id: "price_yearly", recurring: { interval: "year" }, unit_amount: 20000 }),
        price({ id: "price_monthly", recurring: { interval: "month" }, unit_amount: 2000 }),
      ]),
      product(fullMetadata),
      NOW
    );

    const row = await planRow("pro");
    expect(row?.stripe_price_id).toBe("price_monthly");
    expect(row?.amount_cents).toBe(2000);
    expect(row?.interval).toBe("month");
  });

  it("never picks a one-off price", async () => {
    // A non-recurring price on a plan product is a mistake; subscribing
    // somebody to it would be a worse one.
    await syncProductToPlan(
      env.DB,
      stripeStub([price({ id: "price_once", recurring: null })]),
      product(fullMetadata),
      NOW
    );
    expect((await planRow("pro"))?.stripe_price_id).toBeNull();
  });

  it("records a product that has no price yet", async () => {
    // The ordinary state right after `terraform apply`: Terraform creates the
    // product first, so product.created usually arrives before its price
    // exists. The row lands, the price follows on the next sync, and checkout
    // refuses the plan in the meantime rather than assuming one.
    const result = await syncProductToPlan(env.DB, stripeStub([]), product(fullMetadata), NOW);
    expect(result).toEqual({ planId: "pro", priceId: null });
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
