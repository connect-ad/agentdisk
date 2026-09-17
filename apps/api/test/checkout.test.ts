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
import { createCheckoutSession, getBilling } from "../src/routes/billing";
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
    `UPDATE organizations SET stripe_subscription_id = NULL, plan = 'free' WHERE id = ?`
  )
    .bind(ORG_ID)
    .run();
  // Migration 0012 seeds no Stripe ids, because the catalogue does not exist in
  // Stripe at migration time. Give the paid plans a price so the tests that are
  // not about a missing price get past that check.
  await env.DB.prepare(
    `UPDATE plans SET stripe_price_id = 'price_' || id WHERE amount_cents > 0`
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
  async function billing(): Promise<{ purchasable: string[] }> {
    const res = await getBilling(owner(), deps);
    return (await res.json()) as { purchasable: string[] };
  }

  it("lists the paid plans that have a synced price, in display order", async () => {
    expect((await billing()).purchasable).toEqual(["basic", "pro", "team"]);
  });

  it("excludes free, which is the absence of a subscription", async () => {
    expect((await billing()).purchasable).not.toContain("free");
  });

  it("excludes a plan whose price has not been synced from Stripe", async () => {
    // The exact state a freshly migrated environment is in before the
    // catalogue sync has ever run.
    await env.DB.prepare(`UPDATE plans SET stripe_price_id = NULL WHERE id = 'pro'`).run();
    invalidateCatalogue();

    const { purchasable } = await billing();
    expect(purchasable).toEqual(["basic", "team"]);
  });

  it("sends ids only, never a Stripe identifier or a restated price", async () => {
    const res = await getBilling(owner(), deps);
    const text = await res.text();
    expect(text).not.toMatch(/price_|prod_/);
    // The numbers are the client's business, hardcoded there. If this starts
    // failing, the server has begun restating the pricing table.
    expect(text).not.toMatch(/storageBytes|amountCents/);
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
    expect(err.message).toMatch(/portal/i);
  });

  it("refuses a plan whose price has not been synced from Stripe", async () => {
    // The catalogue knows the plan but not its price, which means the Stripe
    // sync has not run here. Reported as our fault, because it is: the caller
    // did nothing wrong and no other plan choice would help.
    await env.DB.prepare(`UPDATE plans SET stripe_price_id = NULL WHERE id = 'pro'`).run();
    invalidateCatalogue();

    const err = await refusal(owner(), { plan: "pro" });
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.internalReason).toMatch(/stripe_price_id/);
  });

  it("does not leak the internal reason to the caller", async () => {
    await env.DB.prepare(`UPDATE plans SET stripe_price_id = NULL WHERE id = 'team'`).run();
    invalidateCatalogue();

    const err = await refusal(owner(), { plan: "team" });
    expect(err.message).not.toMatch(/stripe_price_id/);
  });
});
