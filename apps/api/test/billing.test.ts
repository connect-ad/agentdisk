/**
 * Billing — 14 PART 29.3/29.4.
 *
 * The two things worth proving are the ones that are invisible when wrong. A
 * webhook that accepts an unsigned payload hands anybody who finds the URL the
 * ability to mark themselves paid, and it looks exactly like a working
 * integration until somebody tries it. And a `past_due` account that can still
 * write is a subscription nobody has any reason to renew.
 *
 * The signature is computed here the way Stripe computes it, rather than
 * stubbed, so the verification being exercised is the real one.
 */

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { assertWithinQuota } from "../src/lib/quota";
import { limitsFor } from "../src/lib/plans";
import { ApiError } from "../src/lib/errors";
import { NOW, WORKSPACE_A, bearer, seedApiKey, seedTwoWorkspaces } from "./helpers";

const URL_BASE = "https://api-dev.agentdisk.io";
const ORG_ID = "org_TESTORG";

/** Matches the value vitest.config.ts binds; the signature must agree with it. */
const WEBHOOK_SECRET = "whsec_test_secret";

async function stripeSignature(payload: string, timestamp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`)
  );
  const hex = Array.from(new Uint8Array(signed))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${hex}`;
}

function subscriptionEvent(type: string, status: string, customerId: string): string {
  return JSON.stringify({
    id: "evt_test",
    object: "event",
    type,
    data: {
      object: {
        id: "sub_test",
        object: "subscription",
        customer: customerId,
        status,
        items: { data: [{ price: { id: "price_test" } }] },
      },
    },
  });
}

async function post(payload: string, signature: string | null): Promise<Response> {
  return SELF.fetch(`${URL_BASE}/v1/webhooks/stripe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature === null ? {} : { "stripe-signature": signature }),
    },
    body: payload,
  });
}

async function billingStatus(): Promise<string> {
  const row = await env.DB.prepare(`SELECT billing_status FROM organizations WHERE id = ?`)
    .bind(ORG_ID)
    .first<{ billing_status: string }>();
  return row?.billing_status ?? "missing";
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  await env.DB.prepare(`DELETE FROM api_keys`).run();
  await env.DB.prepare(
    `UPDATE organizations SET stripe_customer_id = 'cus_test', billing_status = 'active',
            stripe_subscription_id = NULL WHERE id = ?`
  ).bind(ORG_ID).run();
  await env.DB.prepare(`DELETE FROM plans`).run();
  await env.DB.prepare(
    `INSERT INTO plans (id, name, amount_cents, currency, interval, stripe_price_id,
                        is_public, sort_order, created_at, updated_at)
     VALUES ('pro', 'Pro', 1900, 'usd', 'month', 'price_test', 1, 1, ?, ?)`
  ).bind(NOW, NOW).run();
});

describe("webhook signature", () => {
  it("refuses a payload with no signature at all", async () => {
    const res = await post(subscriptionEvent("customer.subscription.updated", "active", "cus_test"), null);
    expect(res.status).toBe(401);
    expect(await billingStatus()).toBe("active");
  });

  it("refuses a forged signature", async () => {
    // Anybody who finds this URL must not be able to mark themselves paid.
    const payload = subscriptionEvent("customer.subscription.updated", "active", "cus_test");
    const res = await post(payload, "t=1,v1=deadbeef");
    expect(res.status).toBe(401);
  });

  it("refuses a real signature over a different payload", async () => {
    // The classic replay-with-substitution: a signature that was genuine once,
    // reused over a body somebody edited.
    const genuine = subscriptionEvent("customer.subscription.updated", "past_due", "cus_test");
    const signature = await stripeSignature(genuine, Math.floor(Date.now() / 1000));
    const tampered = subscriptionEvent("customer.subscription.updated", "active", "cus_test");

    const res = await post(tampered, signature);
    expect(res.status).toBe(401);
    expect(await billingStatus()).toBe("active");
  });

  it("accepts a correctly signed event", async () => {
    const payload = subscriptionEvent("customer.subscription.updated", "past_due", "cus_test");
    const res = await post(payload, await stripeSignature(payload, Math.floor(Date.now() / 1000)));

    expect(res.status).toBe(200);
    expect((await res.json()) as { handled: boolean }).toMatchObject({ handled: true });
    expect(await billingStatus()).toBe("past_due");
  });
});

describe("what the webhook does", () => {
  const send = async (payload: string) =>
    post(payload, await stripeSignature(payload, Math.floor(Date.now() / 1000)));

  it("moves the org onto the plan the price maps to", async () => {
    await send(subscriptionEvent("customer.subscription.created", "active", "cus_test"));
    const org = await env.DB.prepare(
      `SELECT plan, stripe_subscription_id FROM organizations WHERE id = ?`
    ).bind(ORG_ID).first<{ plan: string; stripe_subscription_id: string }>();
    expect(org?.plan).toBe("pro");
    expect(org?.stripe_subscription_id).toBe("sub_test");
  });

  it("drops to free when the subscription is deleted", async () => {
    await send(subscriptionEvent("customer.subscription.created", "active", "cus_test"));
    await send(subscriptionEvent("customer.subscription.deleted", "canceled", "cus_test"));

    const org = await env.DB.prepare(
      `SELECT plan, billing_status, stripe_subscription_id FROM organizations WHERE id = ?`
    ).bind(ORG_ID).first<{ plan: string; billing_status: string; stripe_subscription_id: string | null }>();
    // Staying on the paid plan would keep enforcing a paid quota for somebody
    // who has stopped paying.
    expect(org?.plan).toBe("free");
    expect(org?.billing_status).toBe("canceled");
    expect(org?.stripe_subscription_id).toBeNull();
  });

  it("marks past_due on a failed payment and clears it on a successful one", async () => {
    const failed = JSON.stringify({
      id: "evt_f", object: "event", type: "invoice.payment_failed",
      data: { object: { id: "in_1", object: "invoice", customer: "cus_test" } },
    });
    await send(failed);
    expect(await billingStatus()).toBe("past_due");

    const paid = JSON.stringify({
      id: "evt_s", object: "event", type: "invoice.payment_succeeded",
      data: { object: { id: "in_1", object: "invoice", customer: "cus_test" } },
    });
    await send(paid);
    expect(await billingStatus()).toBe("active");
  });

  it("does not resurrect a canceled account on a stray payment", async () => {
    await env.DB.prepare(`UPDATE organizations SET billing_status = 'canceled' WHERE id = ?`)
      .bind(ORG_ID).run();

    const paid = JSON.stringify({
      id: "evt_s2", object: "event", type: "invoice.payment_succeeded",
      data: { object: { id: "in_2", object: "invoice", customer: "cus_test" } },
    });
    await send(paid);
    // Only past_due is lifted. Reactivating here would restore access somebody
    // deliberately gave up.
    expect(await billingStatus()).toBe("canceled");
  });

  it("acknowledges an event it does not handle rather than failing", async () => {
    // Answering non-2xx would make Stripe retry, back off, and eventually
    // disable the endpoint over something we were never going to act on.
    const other = JSON.stringify({
      id: "evt_x", object: "event", type: "customer.updated",
      data: { object: { id: "cus_test", object: "customer" } },
    });
    const res = await send(other);
    expect(res.status).toBe(200);
    expect((await res.json()) as { handled: boolean }).toMatchObject({ handled: false });
  });

  it("ignores an event for a customer we do not know", async () => {
    const res = await send(subscriptionEvent("customer.subscription.updated", "past_due", "cus_stranger"));
    expect(res.status).toBe(200);
    expect(await billingStatus()).toBe("active");
  });
});

describe("what an unpaid account may still do", () => {
  const workspace = {
    id: WORKSPACE_A, org_id: ORG_ID, name: "A", status: "active",
    plan_override: null, org_plan: "free",
    storage_bytes_used: 0, file_count: 0, egress_bytes_period: 0, requests_period: 0,
    period_reset_at: NOW + 86400000, created_at: NOW, updated_at: NOW,
  } as never;
  const limits = limitsFor(null, "free");

  it("blocks a write while past_due", () => {
    expect(() => assertWithinQuota(workspace, limits, { bytes: 100, files: 1 }, NOW, "past_due"))
      .toThrow(ApiError);
  });

  it("still allows reads", () => {
    // Locking somebody out of their own files to chase a payment turns a
    // billing problem into a support crisis.
    expect(() => assertWithinQuota(workspace, limits, {}, NOW, "past_due")).not.toThrow();
    expect(() => assertWithinQuota(workspace, limits, {}, NOW, "canceled")).not.toThrow();
  });

  it("reports it as a limit, not as a permission failure", () => {
    // The credential is fine; what ran out is the account's standing, which is
    // the same category of thing as running out of storage.
    try {
      assertWithinQuota(workspace, limits, { bytes: 1 }, NOW, "canceled");
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as ApiError).code).toBe("LIMIT_EXCEEDED");
    }
  });

  it("does not block anything while active", () => {
    expect(() => assertWithinQuota(workspace, limits, { bytes: 100, files: 1 }, NOW, "active"))
      .not.toThrow();
  });
});

describe("the portal", () => {
  it("is not reachable with an agent key", async () => {
    // Cancelling a subscription is authority over the account, not over this
    // workspace's contents.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "write", "list"] });
    const res = await SELF.fetch(`${URL_BASE}/v1/billing/portal-session`, {
      method: "POST",
      headers: bearer(token),
    });
    expect(res.status).toBe(403);
  });
});
