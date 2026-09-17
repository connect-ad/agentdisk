/**
 * Editing the plan catalogue from the console — 32 PART 6.
 *
 * The Stripe client is stubbed and records what it was asked to do, because
 * what matters here is not Stripe's API but the ORDER and the ROLE gate around
 * it: that a failed push leaves the local row untouched, that a price change
 * mints a new Price rather than mutating one, that a support engineer cannot
 * reach any of it, and that every attempt — including a refused one — is
 * written down.
 *
 * The round-trip test at the top is the one that would otherwise fail silently.
 * An admin edit writes entitlements into Stripe metadata, and the
 * `product.updated` webhook our own push triggers reads that metadata straight
 * back into the same columns. If the encoder and the decoder ever disagree, an
 * edit would appear to work and then quietly change the entitlement it just
 * set, moments later, by a path nobody was looking at.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { StaffPlanAccess } from "../src/staff/plans-access";
import { metadataForPlan, syncProductToPlan } from "../src/billing/plan-sync";
import { invalidateCatalogue } from "../src/billing/catalogue";
import { ApiError } from "../src/lib/errors";
import type { StaffUser } from "../src/staff/access";
import type { Stripe } from "../src/billing/stripe";

const NOW = 1_790_000_000_000;

function staff(role: StaffUser["role"], id = `stf_${role}`): StaffUser {
  return { id, email: `${role}@agentdisk.io`, role, disabledAt: null } as StaffUser;
}

/** Records every call, and can be told to fail on any one of them. */
function stripeStub(
  options: {
    failOn?: "products.update" | "prices.create" | "products.create";
    products?: unknown[];
    prices?: unknown[];
  } = {}
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const track = (method: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      if (options.failOn === method) throw new Error(`stripe refused: ${method}`);
      return result;
    };

  const client = {
    products: {
      update: track("products.update", { id: "prod_pro" }),
      create: track("products.create", { id: "prod_new" }),
      retrieve: track("products.retrieve", {
        id: "prod_pro",
        name: "AgentDisk Pro",
        description: "From Stripe.",
        metadata: { package_id: "agentdisk-pro", plan_id: "pro", agents: "99" },
      }),
      list: track("products.list", { data: options.products ?? [] }),
    },
    prices: {
      create: track("prices.create", { id: "price_new" }),
      update: track("prices.update", { id: "price_old", active: false }),
      list: track("prices.list", { data: options.prices ?? [] }),
    },
  } as unknown as Stripe;

  return { client, calls, named: (m: string) => calls.filter(c => c.method === m) };
}

const access = (role: StaffUser["role"]) =>
  new StaffPlanAccess(env.DB, staff(role), "req_TEST", NOW, "203.0.113.9");

async function planRow(id: string) {
  return env.DB.prepare(`SELECT * FROM plans WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
}

async function fleetActions(action: string) {
  const rows = await env.DB.prepare(
    `SELECT action, actor_role, target_id, result, reason, source_ip FROM staff_actions WHERE action = ?`
  )
    .bind(action)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM staff_actions`).run();
  // Migration 0012 seeds the four plans with NULL Stripe ids, because the
  // catalogue does not exist in Stripe at migration time. Give Pro a product
  // and a price so the tests that are not about a missing product get past it.
  await env.DB.prepare(
    `UPDATE plans SET stripe_product_id = 'prod_' || id, stripe_price_id = 'price_' || id`
  ).run();
  invalidateCatalogue();
});

/* ------------------------------ round trip ------------------------------- */

describe("metadata round trip", () => {
  it("survives a push to Stripe and the webhook that comes back", async () => {
    const before = await planRow("pro");
    const metadata = metadataForPlan(before as never);

    // Exactly what Stripe would hand back on product.updated, carrying the
    // metadata we just wrote.
    await syncProductToPlan(
      env.DB,
      {
        prices: {
          list: async () => ({
            data: [
              {
                id: "price_pro",
                active: true,
                currency: "usd",
                unit_amount: before?.amount_cents,
                recurring: { interval: "month" },
              },
            ],
          }),
        },
      } as unknown as Stripe,
      {
        id: "prod_pro",
        name: before?.name,
        description: before?.description,
        active: true,
        metadata,
      } as unknown as Stripe.Product,
      NOW
    );

    const after = await planRow("pro");
    for (const column of [
      "storage_bytes",
      "max_file_bytes",
      "agents",
      "members",
      "workspaces",
      "api_keys",
      "file_count",
      "egress_bytes_period",
      "requests_period",
      "priority_support",
      "amount_cents",
    ]) {
      expect(`${column}=${after?.[column]}`).toBe(`${column}=${before?.[column]}`);
    }
  });

  it("omits a NULL column rather than writing it as zero", () => {
    // The direction that would do damage. A null means "this row did not say",
    // which the resolver answers from the lib/plans.ts floor; writing "0" would
    // set a real limit of zero bytes and lock somebody out of their account.
    const metadata = metadataForPlan({
      id: "pro",
      package_id: "agentdisk-pro",
      storage_bytes: null,
      file_count: -1,
      egress_bytes_period: -1,
      requests_period: -1,
      max_file_bytes: 100,
      agents: null,
      members: 5,
      workspaces: 10,
      api_keys: 20,
      priority_support: 1,
      is_default: 0,
      sort_order: 30,
    });

    expect(metadata["storage_bytes"]).toBeUndefined();
    expect(metadata["agents"]).toBeUndefined();
    expect(metadata["file_count"]).toBe("unlimited");
    expect(metadata["members"]).toBe("5");
  });
});

/* -------------------------------- editing -------------------------------- */

describe("editing a plan", () => {
  it("pushes to Stripe and then writes the row", async () => {
    const stripe = stripeStub();
    const result = await access("admin").update(
      stripe.client,
      "pro",
      { agents: 25, name: "AgentDisk Pro" },
      "raising the agent allowance"
    );

    expect(stripe.named("products.update")).toHaveLength(1);
    expect(result.plan.agents).toBe(25);
    expect((await planRow("pro"))?.last_synced_direction).toBe("outbound");
  });

  it("leaves the row untouched when Stripe refuses", async () => {
    // The ordering this class exists to guarantee. A local-only save would
    // produce a pricing table that says one thing while Stripe charges another,
    // and nothing would surface the disagreement until somebody was billed.
    const before = await planRow("pro");
    const stripe = stripeStub({ failOn: "products.update" });

    await expect(
      access("admin").update(stripe.client, "pro", { agents: 999 }, "should not land")
    ).rejects.toThrow(/stripe refused/);

    expect((await planRow("pro"))?.agents).toBe(before?.agents);
  });

  it("mints a new price and archives the old one, never mutating a price", async () => {
    const stripe = stripeStub();
    const result = await access("admin").update(
      stripe.client,
      "pro",
      { amount_cents: 2500 },
      "price rise"
    );

    expect(result.repriced).toBe(true);
    expect(stripe.named("prices.create")).toHaveLength(1);
    // Archived AFTER the new one exists: the other order leaves a window with
    // no sellable price, and a checkout started in it fails for a reason the
    // customer cannot act on.
    const order = stripe.calls.map(c => c.method);
    expect(order.indexOf("prices.create")).toBeLessThan(order.indexOf("prices.update"));
    expect((await planRow("pro"))?.stripe_price_id).toBe("price_new");
  });

  it("does not touch the price when the amount did not change", async () => {
    const current = await planRow("pro");
    const stripe = stripeStub();
    const result = await access("admin").update(
      stripe.client,
      "pro",
      { amount_cents: current?.amount_cents as number, agents: 11 },
      "same price"
    );

    expect(result.repriced).toBe(false);
    expect(stripe.named("prices.create")).toHaveLength(0);
  });

  it("refuses a plan that is not in Stripe yet", async () => {
    await env.DB.prepare(`UPDATE plans SET stripe_product_id = NULL WHERE id = 'basic'`).run();
    const stripe = stripeStub();

    await expect(
      access("admin").update(stripe.client, "basic", { agents: 9 }, "nope")
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(stripe.calls).toHaveLength(0);
  });

  it("refuses a negative or fractional price", async () => {
    const stripe = stripeStub();
    await expect(
      access("admin").update(stripe.client, "pro", { amount_cents: -100 }, "x")
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      access("admin").update(stripe.client, "pro", { amount_cents: 19.5 }, "x")
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("demotes the previous default when promoting one", async () => {
    // idx_plans_one_default is a partial unique index, so promoting without
    // demoting fails on a constraint the operator never saw.
    await env.DB.prepare(`UPDATE plans SET is_default = 1 WHERE id = 'free'`).run();
    await env.DB.prepare(`UPDATE plans SET is_default = 0 WHERE id != 'free'`).run();

    await access("admin").update(stripeStub().client, "basic", { is_default: 1 }, "new default");

    expect((await planRow("basic"))?.is_default).toBe(1);
    expect((await planRow("free"))?.is_default).toBe(0);
  });
});

/* -------------------------------- retiring ------------------------------- */

describe("retiring a plan", () => {
  it("keeps the row, so existing subscribers keep their entitlements", async () => {
    await env.DB.prepare(`UPDATE plans SET is_default = 0 WHERE id = 'basic'`).run();
    const before = await planRow("basic");

    await access("super_admin").retire(stripeStub().client, "basic", "withdrawn");

    const after = await planRow("basic");
    expect(after).not.toBeNull();
    expect(after?.is_public).toBe(0);
    expect(after?.stripe_price_id).toBeNull();
    // The entitlements survive: the row is what resolves a live subscription's
    // price back to limits.
    expect(after?.storage_bytes).toBe(before?.storage_bytes);
  });

  it("refuses to retire the default plan", async () => {
    await env.DB.prepare(`UPDATE plans SET is_default = 0`).run();
    await env.DB.prepare(`UPDATE plans SET is_default = 1 WHERE id = 'free'`).run();

    await expect(
      access("super_admin").retire(stripeStub().client, "free", "x")
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

/* ------------------------------ role gating ------------------------------ */

describe("who may do what", () => {
  it("refuses a support engineer, and records the refusal", async () => {
    await expect(
      access("support").update(stripeStub().client, "pro", { agents: 1 }, "x")
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // The denial is a fact worth holding. A log of only successful actions
    // cannot show somebody repeatedly trying what their role forbids.
    const denials = await fleetActions("staff.denied");
    expect(denials).toHaveLength(1);
    expect(denials[0]?.result).toBe("denied");
  });

  it("lets admin edit but not create or retire", async () => {
    await expect(
      access("admin").create(stripeStub().client, { id: "scale" }, "x")
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      access("admin").retire(stripeStub().client, "basic", "x")
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("records the actor, the reason and the address on a successful edit", async () => {
    await access("admin").update(stripeStub().client, "pro", { agents: 12 }, "support request 41");

    const [edit] = await fleetActions("plan.edit");
    expect(edit?.actor_role).toBe("admin");
    expect(edit?.target_id).toBe("pro");
    expect(edit?.reason).toBe("support request 41");
    expect(edit?.source_ip).toBe("203.0.113.9");

    // The push is recorded as its own action, because "we changed the row" and
    // "we changed what Stripe will charge" are different facts.
    expect(await fleetActions("plan.push_to_stripe")).toHaveLength(1);
  });
});

/* -------------------------------- creating ------------------------------- */

describe("creating a plan", () => {
  it("creates the product and a price, and records it", async () => {
    const stripe = stripeStub();
    const created = await access("super_admin").create(
      stripe.client,
      { id: "scale", name: "AgentDisk Scale", amount_cents: 20000, agents: 200 },
      "new tier"
    );

    expect(created.stripe_product_id).toBe("prod_new");
    expect(created.stripe_price_id).toBe("price_new");
    expect(created.agents).toBe(200);
    expect(await fleetActions("plan.create")).toHaveLength(1);
  });

  it("creates no price for a free plan", async () => {
    // Free is the absence of a subscription, not a $0 one. A $0 recurring price
    // would give every account on it a real subscription that can go past_due.
    const stripe = stripeStub();
    const created = await access("super_admin").create(
      stripe.client,
      { id: "starter", amount_cents: 0 },
      "free tier"
    );

    expect(created.stripe_price_id).toBeNull();
    expect(stripe.named("prices.create")).toHaveLength(0);
  });

  it("refuses an id that already exists, and one that is not an id", async () => {
    await expect(
      access("super_admin").create(stripeStub().client, { id: "pro" }, "x")
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      access("super_admin").create(stripeStub().client, { id: "Not An Id" }, "x")
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

/* ---------------------------- diff, then sync ---------------------------- */

describe("sync from Stripe", () => {
  const product = (overrides: Record<string, unknown> = {}) => ({
    id: "prod_pro",
    name: "AgentDisk Pro",
    description: null,
    active: true,
    metadata: { package_id: "agentdisk-pro", plan_id: "pro", agents: "77" },
    ...overrides,
  });

  it("reports the fields that differ, and ignores products that are not ours", async () => {
    const stripe = stripeStub({
      products: [
        product(),
        // Somebody else's purpose in the same Stripe account. No package_id, so
        // it must never appear in a pricing diff.
        { id: "prod_consulting", name: "Consulting day", active: true, metadata: {} },
      ],
      prices: [{ id: "price_pro", active: true, unit_amount: 2000, recurring: { interval: "month" } }],
    });

    const diffs = await access("admin").stripeDiff(stripe.client);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.planId).toBe("pro");
    expect(diffs[0]?.fields.map(f => f.field)).toContain("agents");
  });

  it("applies only the ticked fields", async () => {
    const before = await planRow("pro");
    const stripe = stripeStub();

    const applied = await access("admin").syncFromStripe(
      stripe.client,
      [{ planId: "pro", fields: ["agents"] }],
      "pulling the agent count back"
    );

    expect(applied).toEqual([{ planId: "pro", applied: ["agents"] }]);
    const after = await planRow("pro");
    expect(after?.agents).toBe(99);
    // The name differs in the stub too, and was NOT ticked. A sync that took it
    // anyway would be the one-click pull the diff exists to prevent.
    expect(after?.name).toBe(before?.name);
    expect(after?.last_synced_direction).toBe("inbound");
  });

  it("ignores a field nobody may sync", async () => {
    // Identity, not content. A sync that could rewrite these could repoint one
    // plan's row at another plan's Stripe product.
    const applied = await access("admin").syncFromStripe(
      stripeStub().client,
      [{ planId: "pro", fields: ["id", "stripe_product_id", "package_id"] }],
      "x"
    );
    expect(applied).toHaveLength(0);
    expect((await planRow("pro"))?.stripe_product_id).toBe("prod_pro");
  });
});
