/**
 * The purchase path — `GET /v1/plans` and `POST /v1/billing/checkout-session`.
 *
 * Until this existed the product priced Pro and Team and could not sell either:
 * the billing API offered only the Stripe portal, which manages a subscription
 * that already exists and cannot create one (backlog/024).
 *
 * Every checkout test here is a refusal, and that is deliberate rather than
 * lazy. The
 * happy path ends in an outbound Stripe call, which this suite does not make;
 * but each guard below runs *before* that call, and each one protects something
 * that fails silently when it is wrong — a second subscription on the same
 * card, a workspace admin committing the account owner to a recurring charge,
 * or a client naming a Stripe price directly and buying an archived one.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cancelSubscription,
  changePlan,
  createCheckoutSession,
  getBilling,
  resumeSubscription,
} from "../src/routes/billing";
import { invalidateCatalogue } from "../src/billing/catalogue";
import { ApiError } from "../src/lib/errors";
import type { AuthContext } from "../src/middleware/auth";
import { NOW, WORKSPACE_A, seedTwoWorkspaces } from "./helpers";

const ORG_ID = "org_TESTORG";

const deps = {
  db: env.DB,
  secretKey: "sk_test_not_used_these_all_refuse_first",
  returnUrl: "https://app-dev.agentdisk.io/app",
  dashboardUrl: "https://app-dev.agentdisk.io",
};

/**
 * Enough context for the guards, and no more.
 *
 * A real AuthContext carries scoped repositories and a storage client that
 * nothing on this path touches. Fabricating those would test the fixture.
 */
function ctxFor(identity: {
  kind: "firebase_user" | "api_key";
  role?: string;
}): AuthContext {
  return {
    now: NOW,
    identity,
    workspaceId: WORKSPACE_A,
    workspace: { slug: "workspace-a" },
  } as unknown as AuthContext;
}

const owner = () => ctxFor({ kind: "firebase_user", role: "owner" });

function body(payload: unknown): Request {
  return new Request("https://api.test/v1/billing/checkout-session", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function refusal(ctx: AuthContext, payload: unknown): Promise<ApiError> {
  try {
    await createCheckoutSession(ctx, body(payload), deps);
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected createCheckoutSession to refuse");
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  invalidateCatalogue();
  await env.DB.prepare(
    `UPDATE organizations SET stripe_subscription_id = NULL, plan = 'free',
            billing_status = 'active', current_period_end = NULL, purge_after = NULL,
            billing_interval = NULL, cancel_at_period_end = 0, past_due_since = NULL
      WHERE id = ?`
  )
    .bind(ORG_ID)
    .run();
  // Migration 0012 seeds no Stripe ids, because the catalogue does not exist in
  // Stripe at migration time. Give the paid plans a price so the tests that are
  // not about a missing price get past that check.
  //
  // The yearly columns are reset to NULL in the same breath. A test that mints
  // a yearly price must not leave one behind for the next: "this plan is sold
  // only monthly" is a real state several tests below depend on, and it is
  // exactly the state a leaked fixture destroys.
  await env.DB.prepare(
    `UPDATE plans SET stripe_price_id = 'price_' || id,
            stripe_yearly_price_id = NULL, amount_cents_yearly = NULL
      WHERE amount_cents > 0`
  ).run();
});

/**
 * `purchasable` is the ONLY plan data the server sends a client.
 *
 * Every number a customer reads - price, storage, agent count - is hardcoded in
 * the dashboard and on the marketing page. The one thing the front end cannot
 * work out for itself is whether a plan has a Stripe price in this particular
 * environment, because migration 0012 seeds the catalogue with NULL price ids
 * and they stay NULL until the sync runs. Without this list the dashboard would
 * render an upgrade button whose only possible outcome is a 500.
 */
describe("GET /v1/billing — purchasable", () => {
  interface Purchasable {
    id: string;
    monthlyCents: number | null;
    yearlyCents: number | null;
    savePercent: number | null;
  }

  async function billing(): Promise<{ purchasable: Purchasable[] }> {
    const res = await getBilling(owner(), deps);
    return (await res.json()) as { purchasable: Purchasable[] };
  }

  const ids = async () => (await billing()).purchasable.map(p => p.id);

  it("lists the paid plans that have a synced price, in display order", async () => {
    expect(await ids()).toEqual(["basic", "pro", "team"]);
  });

  it("excludes free, which is the absence of a subscription", async () => {
    expect(await ids()).not.toContain("free");
  });

  it("reports each cadence separately, so a missing yearly price hides no button", async () => {
    // A plan can be sold monthly, yearly or both, and the front end cannot know
    // which without being told — the columns are NULL until the catalogue sync
    // mints the prices. Rendering a yearly button for a plan with no yearly
    // price produces a checkout that can only fail.
    await env.DB.prepare(
      `UPDATE plans SET stripe_yearly_price_id = 'price_pro_year', amount_cents_yearly = 20400
        WHERE id = 'pro'`
    ).run();
    invalidateCatalogue();

    const rows = (await billing()).purchasable;
    const pro = rows.find(p => p.id === "pro")!;
    const team = rows.find(p => p.id === "team")!;

    expect(pro.monthlyCents).toBe(2000);
    expect(pro.yearlyCents).toBe(20400);
    // 12 × $20 = $240; $204 is 15% off.
    expect(pro.savePercent).toBe(15);

    expect(team.yearlyCents).toBeNull();
    expect(team.savePercent).toBeNull();
  });

  it("excludes a plan whose price has not been synced from Stripe", async () => {
    // The exact state a freshly migrated environment is in before the
    // catalogue sync has ever run.
    await env.DB.prepare(`UPDATE plans SET stripe_price_id = NULL WHERE id = 'pro'`).run();
    invalidateCatalogue();

    expect(await ids()).toEqual(["basic", "team"]);
  });

  it("never sends a Stripe identifier, whatever else it sends", async () => {
    // The rule that has not moved. A price or product id in this response is a
    // price a client could name at checkout, and naming a price directly is how
    // somebody buys an archived one nobody is meant to be sold any more.
    const res = await getBilling(owner(), deps);
    expect(await res.text()).not.toMatch(/price_|prod_/);
  });

  it("sends the two amounts and no other plan data", async () => {
    // The amounts ARE now sent, deliberately, and this is the boundary of that
    // concession: they are what Stripe will actually charge, and a dashboard
    // quoting a figure the catalogue has since changed is how somebody is
    // surprised by their own invoice. Entitlements stay hardcoded client-side —
    // if storage or agent counts appear here, the server has started restating
    // the pricing table and the two copies will drift.
    const res = await getBilling(owner(), deps);
    const text = await res.text();
    expect(text).not.toMatch(/storageBytes|storage_bytes|agents|fileCount/);
  });
});

describe("POST /v1/billing/checkout-session", () => {
  it("refuses an API key", async () => {
    // An agent credential committing the account to a recurring charge is
    // authority it was never given.
    const err = await refusal(ctxFor({ kind: "api_key" }), { plan: "pro" });
    expect(err.code).toBe("FORBIDDEN");
  });

  it("refuses a workspace admin who is not the account owner", async () => {
    const err = await refusal(ctxFor({ kind: "firebase_user", role: "admin" }), { plan: "pro" });
    expect(err.code).toBe("FORBIDDEN");
  });

  it("refuses a body that names no plan", async () => {
    expect((await refusal(owner(), {})).code).toBe("VALIDATION_ERROR");
    expect((await refusal(owner(), { plan: "" })).code).toBe("VALIDATION_ERROR");
    expect((await refusal(owner(), { plan: 7 })).code).toBe("VALIDATION_ERROR");
  });

  it("refuses a plan nobody sells", async () => {
    expect((await refusal(owner(), { plan: "enterprise" })).code).toBe("VALIDATION_ERROR");
  });

  it("refuses to check out the free plan", async () => {
    // Free is the absence of a subscription, not a $0 one. A $0 recurring price
    // would give every free account a real subscription that can go past_due.
    const err = await refusal(owner(), { plan: "free" });
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toMatch(/free plan/i);
  });

  it("refuses a second subscription for one organization", async () => {
    // One live subscription per organization. A second checkout would produce a
    // second subscription on the same card - the kind of duplicate nobody
    // notices until the second invoice.
    await env.DB.prepare(`UPDATE organizations SET stripe_subscription_id = 'sub_x' WHERE id = ?`)
      .bind(ORG_ID)
      .run();

    const err = await refusal(owner(), { plan: "pro" });
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toMatch(/billing page/i);
  });

  it("refuses a plan whose price has not been synced from Stripe", async () => {
    // The catalogue knows the plan but not its price, which means the Stripe
    // sync has not run here. Reported as our fault, because it is: the caller
    // did nothing wrong and no other plan choice would help.
    await env.DB.prepare(`UPDATE plans SET stripe_price_id = NULL WHERE id = 'pro'`).run();
    invalidateCatalogue();

    const err = await refusal(owner(), { plan: "pro" });
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.internalReason).toMatch(/no month price/);
  });

  it("does not leak the internal reason to the caller", async () => {
    await env.DB.prepare(`UPDATE plans SET stripe_price_id = NULL WHERE id = 'team'`).run();
    invalidateCatalogue();

    const err = await refusal(owner(), { plan: "team" });
    expect(err.message).not.toMatch(/stripe_price_id|no month price/);
  });
});

/**
/**
 * Interval selection — yearly arrived 25 September 2026.
 *
 * A plan is one identity sold at two cadences, so the client names a plan AND
 * an interval. Getting this wrong is expensive in a specific way: billing
 * somebody yearly for a plan they chose monthly is a 12× overcharge, and the
 * reverse under-charges silently forever.
 */
describe("POST /v1/billing/checkout-session — the interval", () => {
  it("defaults to monthly when the client does not say", async () => {
    // An older dashboard that predates yearly must keep working rather than
    // failing validation on a field it has never sent. Monthly is the safe
    // default: it is the cheaper of the two, so the failure mode of guessing is
    // under-charging rather than a 12× surprise on somebody's card.
    await env.DB.prepare(`UPDATE plans SET stripe_price_id = NULL WHERE id = 'pro'`).run();
    invalidateCatalogue();

    const err = await refusal(owner(), { plan: "pro" });
    expect(err.internalReason).toMatch(/no month price/);
  });

  it("refuses an interval nobody sells", async () => {
    expect((await refusal(owner(), { plan: "pro", interval: "week" })).code).toBe(
      "VALIDATION_ERROR"
    );
    expect((await refusal(owner(), { plan: "pro", interval: 12 })).code).toBe("VALIDATION_ERROR");
  });

  it("refuses yearly for a plan sold only by the month", async () => {
    // Not an error the caller can fix by choosing differently, so it is ours
    // rather than theirs — and it must never fall back to the monthly price,
    // which would charge a month for what the customer chose as a year.
    const err = await refusal(owner(), { plan: "pro", interval: "year" });
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.internalReason).toMatch(/no year price/);
    expect(err.message).not.toMatch(/stripe_price_id|no year price/);
  });
});

/**
 * Cancel, resume and change-plan — the self-service surface.
 *
 * These exist as our own endpoints rather than as a link into Stripe's hosted
 * portal, deliberately. Making somebody leave the product to stop paying is the
 * friction consumer-protection rules were written to remove, and a resume path
 * is only possible if the cancel path is ours to begin with.
 *
 * As everywhere else in this file, each test is a guard that runs before the
 * outbound Stripe call.
 */
describe("the self-service subscription endpoints", () => {
  async function refuse(fn: () => Promise<Response>): Promise<ApiError> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof ApiError) return err;
      throw err;
    }
    throw new Error("expected a refusal");
  }

  async function withSubscription(): Promise<void> {
    await env.DB.prepare(
      `UPDATE organizations SET stripe_subscription_id = 'sub_live', plan = 'pro',
              billing_interval = 'month', current_period_end = ? WHERE id = ?`
    )
      .bind(NOW + 20 * 24 * 60 * 60 * 1000, ORG_ID)
      .run();
  }

  it("refuses an API key on every one of them", async () => {
    // A credential minted to upload files must not be able to end the account's
    // subscription. The scope model has nothing to say about money, so the
    // refusal is by identity kind rather than by op.
    const key = ctxFor({ kind: "api_key" });
    expect((await refuse(() => cancelSubscription(key, deps))).code).toBe("FORBIDDEN");
    expect((await refuse(() => resumeSubscription(key, deps))).code).toBe("FORBIDDEN");
    expect((await refuse(() => changePlan(key, body({ plan: "team" }), deps))).code).toBe(
      "FORBIDDEN"
    );
  });

  it("refuses a workspace member who is not the account owner", async () => {
    const admin = ctxFor({ kind: "firebase_user", role: "admin" });
    expect((await refuse(() => cancelSubscription(admin, deps))).code).toBe("FORBIDDEN");
    expect((await refuse(() => resumeSubscription(admin, deps))).code).toBe("FORBIDDEN");
  });

  it("refuses to cancel what does not exist", async () => {
    const err = await refuse(() => cancelSubscription(owner(), deps));
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toMatch(/no subscription/i);
  });

  it("tells somebody whose subscription already ended to start a new one", async () => {
    // The distinction that matters to a human: "resume" is impossible once
    // Stripe has deleted the subscription, and a Stripe error about a missing
    // object tells them nothing about what to do next.
    const err = await refuse(() => resumeSubscription(owner(), deps));
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toMatch(/already ended/i);
  });

  it("is idempotent when the subscription is already cancelling", async () => {
    // A second press on a stale tab is not an error. The caller wanted the
    // subscription to be cancelling, and it is.
    await withSubscription();
    await env.DB.prepare(`UPDATE organizations SET cancel_at_period_end = 1 WHERE id = ?`)
      .bind(ORG_ID)
      .run();

    const res = await cancelSubscription(owner(), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cancelAtPeriodEnd: true });
  });

  it("refuses to change a plan when there is nothing to change", async () => {
    const err = await refuse(() => changePlan(owner(), body({ plan: "team" }), deps));
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toMatch(/no subscription/i);
  });

  it("refuses to change to a plan nobody sells, before reaching Stripe", async () => {
    await withSubscription();
    const err = await refuse(() => changePlan(owner(), body({ plan: "enterprise" }), deps));
    expect(err.code).toBe("VALIDATION_ERROR");
  });
});

/**
 * What `GET /v1/billing` says about a live subscription.
 *
 * Three facts the screen cannot render without, and none of them cost a Stripe
 * call — they are mirrored into `organizations` by the webhook.
 */
describe("GET /v1/billing — the renewal clock", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("distinguishes a renewal from an ending", async () => {
    // The entire difference between "Renews 24 October" and "Ends 24 October",
    // and it cannot be derived from anything else: a cancelling subscription is
    // still active, still paid up, still entitled to everything it bought.
    await env.DB.prepare(
      `UPDATE organizations SET plan = 'pro', billing_interval = 'month',
              stripe_subscription_id = 'sub_live', current_period_end = ?,
              cancel_at_period_end = 1 WHERE id = ?`
    )
      .bind(NOW + 20 * DAY, ORG_ID)
      .run();

    const res = await getBilling(owner(), deps);
    const { billing } = (await res.json()) as {
      billing: {
        cancelAtPeriodEnd: boolean;
        periodEndsAt: number | null;
        renewalAmountCents: number | null;
        interval: string | null;
      };
    };

    expect(billing.cancelAtPeriodEnd).toBe(true);
    expect(billing.periodEndsAt).toBe(NOW + 20 * DAY);
    expect(billing.interval).toBe("month");
    // No next charge to name, because there will not be one.
    expect(billing.renewalAmountCents).toBeNull();
  });

  it("quotes the next charge from the cadence actually being billed", async () => {
    // Not from the pricing page's headline figure. An account on the yearly
    // price must be told the yearly amount, or the notice it is given will not
    // match the charge that arrives.
    await env.DB.prepare(
      `UPDATE plans SET amount_cents_yearly = 20400, stripe_yearly_price_id = 'price_pro_year'
        WHERE id = 'pro'`
    ).run();
    await env.DB.prepare(
      `UPDATE organizations SET plan = 'pro', billing_interval = 'year',
              stripe_subscription_id = 'sub_live', current_period_end = ? WHERE id = ?`
    )
      .bind(NOW + 40 * DAY, ORG_ID)
      .run();
    invalidateCatalogue();

    const res = await getBilling(owner(), deps);
    const { billing } = (await res.json()) as {
      billing: { renewalAmountCents: number | null; interval: string | null };
    };

    expect(billing.interval).toBe("year");
    expect(billing.renewalAmountCents).toBe(20400);
  });

  it("says nothing about a period for an account that never bought one", async () => {
    // NULL is "never subscribed", which is every free account. It is not
    // "expired", and reporting a grace deadline that has already passed would
    // put a deletion warning on a screen belonging to somebody who owes us
    // nothing.
    const res = await getBilling(owner(), deps);
    const { billing } = (await res.json()) as {
      billing: {
        periodEndsAt: number | null;
        interval: string | null;
        graceEndsAt: number | null;
        renewalAmountCents: number | null;
      };
    };

    expect(billing.periodEndsAt).toBeNull();
    expect(billing.interval).toBeNull();
    expect(billing.graceEndsAt).toBeNull();
    expect(billing.renewalAmountCents).toBeNull();
  });

  it("projects the deletion deadline from the failure, not the period end", async () => {
    // Anchored on when the charge failed. A subscription can fail its charge
    // days after the period boundary — Stripe raises the invoice, attempts it,
    // and only then reports — and counting from the boundary would shorten
    // somebody's grace by however long that took.
    await env.DB.prepare(
      `UPDATE organizations SET plan = 'pro', billing_status = 'past_due',
              current_period_end = ?, past_due_since = ? WHERE id = ?`
    )
      .bind(NOW - 3 * DAY, NOW - 2 * DAY, ORG_ID)
      .run();

    const res = await getBilling(owner(), deps);
    const { billing } = (await res.json()) as {
      billing: { graceEndsAt: number | null; writesBlocked: boolean };
    };

    expect(billing.writesBlocked).toBe(true);
    expect(billing.graceEndsAt).toBe(NOW - 2 * DAY + 7 * DAY);
  });
});
