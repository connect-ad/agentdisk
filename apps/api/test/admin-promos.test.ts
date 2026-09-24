/**
 * Promotion codes from the console — the discount surface.
 *
 * Stripe is stubbed and records what it was asked to do, because what matters
 * here is not Stripe's API but the shape of what we send it: that a coupon is
 * created before the code that points at it, that one-time and unlimited codes
 * are genuinely different requests rather than the same one with an empty
 * field, and that every attempt is written down.
 *
 * There is no `promos` table and no test for one. Stripe counts redemptions
 * atomically at the moment of payment; a local mirror would be a second source
 * of truth for the one number that must not be wrong.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AdminPromoAccess } from "../src/admin/promos-access";
import { ApiError } from "../src/lib/errors";
import type { AdminUser } from "../src/admin/access";
import type { Stripe } from "../src/billing/stripe";

const NOW = 1_790_000_000_000;

function admin(role: AdminUser["role"] = "admin"): AdminUser {
  return { id: `stf_${role}`, email: `${role}@agentdisk.io`, role, disabledAt: null } as AdminUser;
}

/** A coupon as Stripe hands one back, with the metadata we stamp on it. */
function coupon(overrides: Record<string, unknown> = {}) {
  return {
    id: "cou_test",
    percent_off: 50,
    amount_off: null,
    currency: null,
    duration: "once",
    duration_in_months: null,
    metadata: { created_by: "admin@agentdisk.io" },
    ...overrides,
  };
}

/**
 * A promotion code in the shape API version 2026-08-26.dahlia returns: the
 * coupon nested under `promotion`, not at the top level.
 */
function promoCode(overrides: Record<string, unknown> = {}) {
  return {
    id: "promo_test",
    code: "WELCOME50",
    active: true,
    created: NOW / 1000,
    expires_at: null,
    max_redemptions: null,
    times_redeemed: 0,
    promotion: { type: "coupon", coupon: coupon() },
    ...overrides,
  };
}

function stripeStub(options: { list?: unknown[]; created?: unknown } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const track = (method: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result;
    };

  const client = {
    coupons: { create: track("coupons.create", coupon()) },
    promotionCodes: {
      create: track("promotionCodes.create", options.created ?? promoCode()),
      list: track("promotionCodes.list", { data: options.list ?? [promoCode()] }),
      update: track("promotionCodes.update", promoCode({ active: false })),
    },
  } as unknown as Stripe;

  return {
    client,
    calls,
    named: (method: string) => calls.filter(call => call.method === method),
    argsOf: (method: string) =>
      (calls.find(call => call.method === method)?.args[0] ?? {}) as Record<string, unknown>,
  };
}

const access = () => new AdminPromoAccess(env.DB, admin(), "req_TEST", NOW, "203.0.113.9");

async function fleetActions(action: string) {
  const rows = await env.DB.prepare(
    `SELECT action, target_id, metadata, result FROM admin_actions WHERE action = ?`
  )
    .bind(action)
    .all<{ action: string; target_id: string | null; metadata: string; result: string }>();
  return rows.results ?? [];
}

const valid = { code: "welcome50", percentOff: 50, duration: "once" } as const;

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM admin_actions`).run();
});

describe("creating a code", () => {
  it("creates the coupon first, then the code that points at it", async () => {
    // A promotion code cannot exist without a coupon, so the order is not a
    // preference. Reversed, every create would fail on a dangling reference.
    const stripe = stripeStub();
    await access().create(stripe.client, { ...valid });

    expect(stripe.calls.map(call => call.method)).toEqual([
      "coupons.create",
      "promotionCodes.create",
    ]);
  });

  it("uppercases the code, so one string cannot exist twice in two cases", async () => {
    const stripe = stripeStub();
    await access().create(stripe.client, { ...valid });

    expect(stripe.argsOf("promotionCodes.create").code).toBe("WELCOME50");
  });

  it("nests the coupon under `promotion`, as the pinned API version requires", async () => {
    const stripe = stripeStub();
    await access().create(stripe.client, { ...valid });

    expect(stripe.argsOf("promotionCodes.create").promotion).toEqual({
      type: "coupon",
      coupon: "cou_test",
    });
  });

  it("stamps who made it into coupon metadata", async () => {
    // So a code traces back to a person from the Stripe dashboard alone.
    const stripe = stripeStub();
    await access().create(stripe.client, { ...valid });

    expect(stripe.argsOf("coupons.create").metadata).toMatchObject({
      created_by: "admin@agentdisk.io",
    });
  });

  it("audits the creation, with the limits it was given", async () => {
    const stripe = stripeStub();
    await access().create(stripe.client, { ...valid, maxRedemptions: 1 });

    const [row] = await fleetActions("promo.create");
    expect(row).toBeDefined();
    expect(row!.target_id).toBe("promo_test");
    const metadata = JSON.parse(row!.metadata) as Record<string, unknown>;
    expect(metadata["code"]).toBe("WELCOME50");
    expect(metadata["maxRedemptions"]).toBe(1);
  });
});

/**
 * The distinction the console's form exists to make. An empty box meaning "no
 * limit" is the same ambiguity `plans` already forbids between NULL and -1, so
 * the two cases have to reach Stripe as genuinely different requests.
 */
describe("one-time versus multi-use", () => {
  it("sends max_redemptions 1 for a single-use code", async () => {
    const stripe = stripeStub();
    await access().create(stripe.client, { ...valid, maxRedemptions: 1 });

    expect(stripe.argsOf("promotionCodes.create")["max_redemptions"]).toBe(1);
  });

  it("sends a count for a capped code", async () => {
    const stripe = stripeStub();
    await access().create(stripe.client, { ...valid, maxRedemptions: 250 });

    expect(stripe.argsOf("promotionCodes.create")["max_redemptions"]).toBe(250);
  });

  it("omits the field entirely for unlimited, rather than sending a zero", async () => {
    // Stripe reads a missing key as no limit. A zero would be a limit of zero,
    // which is a code nobody can ever use.
    const stripe = stripeStub();
    await access().create(stripe.client, { ...valid });

    expect(stripe.argsOf("promotionCodes.create")).not.toHaveProperty("max_redemptions");
  });

  it("records unlimited as a word in the audit trail", async () => {
    // An absent key in a log reads as "not recorded", which is a different
    // claim from "there is no limit".
    const stripe = stripeStub();
    await access().create(stripe.client, { ...valid });

    const [row] = await fleetActions("promo.create");
    expect((JSON.parse(row!.metadata) as Record<string, unknown>)["maxRedemptions"]).toBe(
      "unlimited"
    );
  });
});

describe("what it refuses before Stripe sees it", () => {
  async function refusal(input: Record<string, unknown>): Promise<ApiError> {
    const stripe = stripeStub();
    try {
      await access().create(stripe.client, input as never);
    } catch (err) {
      expect(stripe.calls).toHaveLength(0);
      if (err instanceof ApiError) return err;
      throw err;
    }
    throw new Error("expected a refusal");
  }

  it("refuses a code with characters nobody can type back reliably", async () => {
    expect((await refusal({ ...valid, code: "50% OFF!" })).code).toBe("VALIDATION_ERROR");
    expect((await refusal({ ...valid, code: "ab" })).code).toBe("VALIDATION_ERROR");
  });

  it("refuses both a percentage and a fixed amount", async () => {
    const err = await refusal({ ...valid, amountOffCents: 500, currency: "usd" });
    expect(err.message).toMatch(/not both/i);
  });

  it("refuses neither", async () => {
    const err = await refusal({ code: "SUMMER", duration: "once" });
    expect(err.message).toMatch(/either/i);
  });

  it("refuses a percentage outside 1 to 100", async () => {
    expect((await refusal({ ...valid, percentOff: 0 })).code).toBe("VALIDATION_ERROR");
    expect((await refusal({ ...valid, percentOff: 101 })).code).toBe("VALIDATION_ERROR");
  });

  it("refuses a fixed amount with no currency", async () => {
    const err = await refusal({ code: "FIVER", amountOffCents: 500, duration: "once" });
    expect(err.message).toMatch(/currency/i);
  });

  it("refuses a repeating discount with no length", async () => {
    const err = await refusal({ ...valid, duration: "repeating" });
    expect(err.message).toMatch(/months/i);
  });

  it("refuses a length on a discount that does not repeat", async () => {
    // Ignoring it would let somebody believe they had capped a `forever` code.
    const err = await refusal({ ...valid, duration: "forever", durationMonths: 3 });
    expect(err.message).toMatch(/only applies/i);
  });

  it("refuses an expiry in the past", async () => {
    const err = await refusal({ ...valid, expiresAt: NOW - 1000 });
    expect(err.message).toMatch(/future/i);
  });
});

describe("listing", () => {
  it("expands the coupon so one screen is one request", async () => {
    const stripe = stripeStub();
    await access().list(stripe.client);

    expect(stripe.argsOf("promotionCodes.list")["expand"]).toEqual(["data.promotion.coupon"]);
  });

  it("reads the discount out of the nested coupon", async () => {
    const stripe = stripeStub();
    const { promos } = await access().list(stripe.client);

    expect(promos).toHaveLength(1);
    expect(promos[0]).toMatchObject({ code: "WELCOME50", percentOff: 50, active: true });
  });

  it("reports no discount rather than a zero when the coupon came back unexpanded", async () => {
    // A plausible zero reads as "no discount". A null is visibly missing, which
    // is the truth: we did not ask for it.
    const stripe = stripeStub({
      list: [promoCode({ promotion: { type: "coupon", coupon: "cou_test" } })],
    });
    const { promos } = await access().list(stripe.client);

    expect(promos[0]!.percentOff).toBeNull();
    expect(promos[0]!.amountOffCents).toBeNull();
  });

  it("keeps unlimited distinguishable from a limit of zero", async () => {
    const stripe = stripeStub({ list: [promoCode({ max_redemptions: null })] });
    const { promos } = await access().list(stripe.client);
    expect(promos[0]!.maxRedemptions).toBeNull();
  });

  it("is audited, because reading who gets a discount is worth recording", async () => {
    const stripe = stripeStub();
    await access().list(stripe.client);
    expect(await fleetActions("promo.view")).toHaveLength(1);
  });
});

describe("deactivating", () => {
  it("deactivates rather than deletes", async () => {
    // Stripe does not allow deleting a promotion code, and discounts already
    // redeemed under it stay attached to real customers' invoices.
    const stripe = stripeStub();
    await access().deactivate(stripe.client, "promo_test", "Campaign over.");

    expect(stripe.argsOf("promotionCodes.update")).toBe("promo_test");
    expect(stripe.named("promotionCodes.update")[0]!.args[1]).toEqual({ active: false });
  });

  it("records the reason and how many times it had been used", async () => {
    const stripe = stripeStub();
    await access().deactivate(stripe.client, "promo_test", "Campaign over.");

    const [row] = await fleetActions("promo.deactivate");
    expect(row).toBeDefined();
    expect((JSON.parse(row!.metadata) as Record<string, unknown>)["code"]).toBe("WELCOME50");
  });
});

/**
 * The console collapsed to one role, so `requireRole` cannot currently refuse
 * anybody. This asserts that rather than asserting a permission matrix that
 * does not exist — the day a tier comes back, this test failing is the reminder
 * that the denial path is live again.
 */
describe("the role gate", () => {
  it("writes no admin.denied row while one role exists", async () => {
    const stripe = stripeStub();
    await access().list(stripe.client);
    await access().create(stripe.client, { ...valid });

    expect(await fleetActions("admin.denied")).toHaveLength(0);
  });
});
