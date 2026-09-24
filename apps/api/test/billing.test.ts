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
const DAY = 24 * 60 * 60 * 1000;
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

function checkoutEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt_checkout",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test",
        object: "checkout.session",
        mode: "subscription",
        customer: "cus_test",
        client_reference_id: ORG_ID,
        subscription: "sub_new",
        ...overrides,
      },
    },
  });
}

function refundEvent(): string {
  return JSON.stringify({
    id: "evt_refund",
    object: "event",
    type: "charge.refunded",
    data: {
      object: {
        id: "ch_test",
        object: "charge",
        customer: "cus_test",
        amount_refunded: 2000,
        currency: "usd",
        refunded: true,
      },
    },
  });
}

interface OrgState {
  plan: string;
  billing_status: string;
  stripe_subscription_id: string | null;
  current_period_end: number | null;
  purge_after: number | null;
}

async function orgState(): Promise<OrgState> {
  const row = await env.DB.prepare(
    `SELECT plan, billing_status, stripe_subscription_id, current_period_end, purge_after
       FROM organizations WHERE id = ?`
  )
    .bind(ORG_ID)
    .first<OrgState>();
  if (row === null) throw new Error("organization missing");
  return row;
}

/**
 * A subscription as Stripe sends it, with the fields this product reads.
 *
 * `current_period_end` sits on the ITEM, not the subscription: the top-level
 * field was removed in recent API versions, and a period genuinely belongs to
 * the items once more than one price can sit on a subscription. We sell exactly
 * one item, so the first is the answer.
 */
function subscription(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sub_live",
    object: "subscription",
    customer: "cus_test",
    status: "active",
    cancel_at_period_end: false,
    items: {
      data: [
        {
          id: "si_1",
          price: { id: "price_test" },
          current_period_end: Math.floor((Date.now() + 30 * DAY) / 1000),
        },
      ],
    },
    ...overrides,
  };
}

function subEvent(type: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt_sub",
    object: "event",
    type,
    data: { object: subscription(overrides) },
  });
}

async function signedPost(payload: string): Promise<Response> {
  return post(payload, await stripeSignature(payload, Math.floor(Date.now() / 1000)));
}

function invoiceEvent(type: string): string {
  return JSON.stringify({
    id: "evt_invoice",
    object: "event",
    type,
    data: {
      object: { id: "in_test", object: "invoice", customer: "cus_test" },
    },
  });
}

/**
 * The subscription lifecycle — where entitlement actually comes from.
 *
 * `customer.subscription.created` / `.updated` are the events that decide what
 * an account is allowed and until when. `checkout.session.completed` is
 * deliberately the thin half of the pair: it binds the subscription id and
 * nothing else, so there is one code path settling entitlements rather than two
 * that must agree forever.
 */
describe("customer.subscription.* · where entitlement comes from", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `UPDATE organizations SET plan = 'free', current_period_end = NULL, purge_after = NULL,
              billing_interval = NULL, past_due_since = NULL, cancel_at_period_end = 0
        WHERE id = ?`
    )
      .bind(ORG_ID)
      .run();
  });

  it("grants the plan and mirrors Stripe's period", async () => {
    const res = await signedPost(subEvent("customer.subscription.created"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { handled: boolean }).handled).toBe(true);

    const org = await orgState();
    expect(org.plan).toBe("pro");
    expect(org.billing_status).toBe("active");
    expect(org.stripe_subscription_id).toBe("sub_live");
    // Mirrored, not computed. This product stopped owning the period when
    // auto-renewal returned; the only correct value is Stripe's.
    const days = (org.current_period_end! - Date.now()) / DAY;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it("records the cadence the subscription actually bills at", async () => {
    // Read from the PRICE, which is the only place it is true. An account
    // billed yearly must be recorded as yearly, or the renewal notice quotes a
    // monthly figure against a charge twelve times larger.
    await env.DB.prepare(
      `UPDATE plans SET stripe_yearly_price_id = 'price_year', amount_cents_yearly = 20400
        WHERE id = 'pro'`
    ).run();

    await signedPost(
      subEvent("customer.subscription.created", {
        items: {
          data: [
            {
              id: "si_1",
              price: { id: "price_year" },
              current_period_end: Math.floor((Date.now() + 365 * DAY) / 1000),
            },
          ],
        },
      })
    );

    const row = await env.DB.prepare(
      `SELECT billing_interval FROM organizations WHERE id = ?`
    )
      .bind(ORG_ID)
      .first<{ billing_interval: string | null }>();
    expect(row?.billing_interval).toBe("year");
    expect((await orgState()).plan).toBe("pro");
  });

  it("carries the cancellation flag, so the screen can say Ends and not Renews", async () => {
    await signedPost(
      subEvent("customer.subscription.updated", { cancel_at_period_end: true })
    );

    const row = await env.DB.prepare(
      `SELECT cancel_at_period_end, billing_status FROM organizations WHERE id = ?`
    )
      .bind(ORG_ID)
      .first<{ cancel_at_period_end: number; billing_status: string }>();

    // Still active and still entitled — a cancelling subscription has paid for
    // the period it is in. Only the flag moves.
    expect(row?.cancel_at_period_end).toBe(1);
    expect(row?.billing_status).toBe("active");
  });

  it("leaves the plan alone when the price maps to nothing we sell", async () => {
    // Undefined rather than a guess. Resolving an unknown price to something
    // arbitrary would silently upgrade or downgrade somebody because a price
    // was renamed in Stripe.
    await env.DB.prepare(`UPDATE organizations SET plan = 'pro' WHERE id = ?`)
      .bind(ORG_ID)
      .run();

    await signedPost(
      subEvent("customer.subscription.updated", {
        items: {
          data: [
            {
              id: "si_1",
              price: { id: "price_unknown" },
              current_period_end: Math.floor((Date.now() + 30 * DAY) / 1000),
            },
          ],
        },
      })
    );

    expect((await orgState()).plan).toBe("pro");
  });

  it("clears the deletion stamp when a subscription comes back from dunning", async () => {
    // **The single most important write in this feature.** Somebody whose card
    // clears on day ten must not be deleted by a sweep that stamped them on day
    // seven. Under manual renewal this was a customer pressing a button; under
    // auto-renewal it is Stripe's own retry, which makes it easier to miss and
    // no less important.
    await env.DB.prepare(
      `UPDATE organizations SET billing_status = 'past_due', past_due_since = ?,
              purge_after = ? WHERE id = ?`
    )
      .bind(Date.now() - 3 * DAY, Date.now() + 4 * DAY, ORG_ID)
      .run();

    await signedPost(subEvent("customer.subscription.updated", { status: "active" }));

    const org = await orgState();
    expect(org.billing_status).toBe("active");
    expect(org.purge_after).toBeNull();

    const row = await env.DB.prepare(`SELECT past_due_since FROM organizations WHERE id = ?`)
      .bind(ORG_ID)
      .first<{ past_due_since: number | null }>();
    expect(row?.past_due_since).toBeNull();
  });
});

/**
 * The two ways a subscription ends.
 *
 * Answering them identically would be wrong in one direction or the other: a
 * customer who chose to leave has not earned a deletion countdown, and an
 * account we could not collect from must not keep its paid quota forever.
 */
describe("customer.subscription.deleted · the two endings", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `UPDATE organizations SET plan = 'pro', billing_status = 'active',
              stripe_subscription_id = 'sub_live', current_period_end = ?,
              billing_interval = 'month', past_due_since = NULL WHERE id = ?`
    )
      .bind(Date.now() + 2 * DAY, ORG_ID)
      .run();
  });

  it("drops a cancelled account to free, and schedules nothing", async () => {
    await signedPost(
      subEvent("customer.subscription.deleted", {
        cancellation_details: { reason: "cancellation_requested" },
      })
    );

    const org = await orgState();
    expect(org.plan).toBe("free");
    expect(org.billing_status).toBe("canceled");
    expect(org.stripe_subscription_id).toBeNull();
    // The period was that subscription's. Leaving it behind would have the
    // dashboard promising a date nothing will honour.
    expect(org.current_period_end).toBeNull();
    // They chose to stop paying, which is not the same as failing to. Nothing
    // is queued for deletion.
    expect(org.purge_after).toBeNull();
  });

  it("expires an account Stripe could not collect from, and keeps its plan", async () => {
    // The plan stays on the paid tier deliberately. Dropping a 500 GB account
    // to Free's 1 GB puts it instantly over quota through no act of its own,
    // during the exact window we are asking it to fix its card — and every
    // usage screen would report a breach it cannot resolve except by deleting
    // the data we are simultaneously threatening to delete.
    await env.DB.prepare(
      `UPDATE organizations SET billing_status = 'past_due', past_due_since = ? WHERE id = ?`
    )
      .bind(Date.now() - 7 * DAY, ORG_ID)
      .run();

    await signedPost(
      subEvent("customer.subscription.deleted", {
        cancellation_details: { reason: "payment_failed" },
      })
    );

    const org = await orgState();
    expect(org.billing_status).toBe("expired");
    expect(org.plan).toBe("pro");

    // The dunning stamp survives, because it is what the deletion schedule
    // counts from. Clearing it here would leave the scheduling pass with
    // nothing to anchor on and the account would never be swept.
    const row = await env.DB.prepare(`SELECT past_due_since FROM organizations WHERE id = ?`)
      .bind(ORG_ID)
      .first<{ past_due_since: number | null }>();
    expect(row?.past_due_since).not.toBeNull();
  });

  it("falls back to our own dunning state when Stripe names no reason", async () => {
    // An API version or a path that does not populate `cancellation_details`
    // must not turn a collection failure into a voluntary cancellation — that
    // would drop the account to free and skip the deletion ladder entirely,
    // which is the generous direction but also the one that loses the audit
    // trail for why somebody's data went.
    await env.DB.prepare(
      `UPDATE organizations SET billing_status = 'past_due', past_due_since = ? WHERE id = ?`
    )
      .bind(Date.now() - 7 * DAY, ORG_ID)
      .run();

    await signedPost(subEvent("customer.subscription.deleted"));

    expect((await orgState()).billing_status).toBe("expired");
  });
});

/**
 * Dunning: the seven days between a failed charge and the end of the ladder.
 *
 * The same seven days as Stripe's own retry window, by configuration rather
 * than coincidence — see `lib/renewal.ts`.
 */
describe("invoice.payment_failed / succeeded · the dunning stamp", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `UPDATE organizations SET plan = 'pro', billing_status = 'active',
              stripe_subscription_id = 'sub_live', past_due_since = NULL,
              purge_after = NULL WHERE id = ?`
    )
      .bind(ORG_ID)
      .run();
  });

  async function pastDueSince(): Promise<number | null> {
    const row = await env.DB.prepare(`SELECT past_due_since FROM organizations WHERE id = ?`)
      .bind(ORG_ID)
      .first<{ past_due_since: number | null }>();
    return row?.past_due_since ?? null;
  }

  it("opens a dunning run on the first failure", async () => {
    await signedPost(invoiceEvent("invoice.payment_failed"));

    expect((await orgState()).billing_status).toBe("past_due");
    expect(await pastDueSince()).not.toBeNull();
  });

  it("does not restart the clock on a retry, or the grace would never end", async () => {
    // Stripe attempts a failing card several times across the window and each
    // attempt sends this event. Overwriting the stamp every time would push the
    // deletion date back with each retry, so an account could sit in grace
    // indefinitely precisely BECAUSE its card kept failing. A redelivered
    // event is the same hazard and the same guard covers it.
    const opened = Date.now() - 4 * DAY;
    await env.DB.prepare(
      `UPDATE organizations SET billing_status = 'past_due', past_due_since = ? WHERE id = ?`
    )
      .bind(opened, ORG_ID)
      .run();

    await signedPost(invoiceEvent("invoice.payment_failed"));

    expect(await pastDueSince()).toBe(opened);
  });

  it("closes the run and cancels a scheduled deletion when payment succeeds", async () => {
    await env.DB.prepare(
      `UPDATE organizations SET billing_status = 'past_due', past_due_since = ?,
              purge_after = ? WHERE id = ?`
    )
      .bind(Date.now() - 3 * DAY, Date.now() + 4 * DAY, ORG_ID)
      .run();

    await signedPost(invoiceEvent("invoice.payment_succeeded"));

    const org = await orgState();
    expect(org.billing_status).toBe("active");
    expect(org.purge_after).toBeNull();
    expect(await pastDueSince()).toBeNull();
  });

  it("does not un-cancel a subscription somebody deliberately ended", async () => {
    // A payment landing against a canceled subscription is a late settlement of
    // an old invoice, not a renewal. Quietly reactivating would restore access
    // somebody chose to give up.
    await env.DB.prepare(
      `UPDATE organizations SET billing_status = 'canceled' WHERE id = ?`
    )
      .bind(ORG_ID)
      .run();

    await signedPost(invoiceEvent("invoice.payment_succeeded"));

    expect((await orgState()).billing_status).toBe("canceled");
  });

  it("does not lift an expiry, because there is nothing left to bill", async () => {
    // By `expired` Stripe has deleted the subscription. Unlocking here would
    // give back an account with no way to charge it again; coming back from
    // expiry is a new checkout.
    await env.DB.prepare(
      `UPDATE organizations SET billing_status = 'expired' WHERE id = ?`
    )
      .bind(ORG_ID)
      .run();

    await signedPost(invoiceEvent("invoice.payment_succeeded"));

    expect((await orgState()).billing_status).toBe("expired");
  });
});

describe("charge.refunded", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `UPDATE organizations SET plan = 'pro', billing_status = 'active',
              stripe_subscription_id = 'sub_live' WHERE id = ?`
    )
      .bind(ORG_ID)
      .run();
  });

  it("does not touch entitlements", async () => {
    // The whole point of handling it separately. Refunding an invoice does not
    // end a subscription - Stripe sends customer.subscription.deleted if one
    // actually ends. Revoking access here would cut off somebody refunded a
    // single month as a goodwill gesture who is still a paying customer.
    const before = await orgState();
    const res = await signedPost(refundEvent());
    expect(res.status).toBe(200);

    expect(await orgState()).toEqual(before);
  });

  it("is acknowledged rather than ignored, so it is recorded", async () => {
    const res = await signedPost(refundEvent());
    expect((await res.json() as { handled: boolean }).handled).toBe(true);
  });
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

  it("blocks a write while expired", () => {
    // The end of the ladder: Stripe exhausted its retries and gave up.
    expect(() => assertWithinQuota(workspace, limits, { bytes: 100, files: 1 }, NOW, "expired"))
      .toThrow(ApiError);
  });

  it("names the likely cause while a card is still being retried", () => {
    // `past_due` is where most accounts that reach this point actually are, and
    // it is almost always an expired card rather than a dispute. "An unpaid
    // invoice" sends somebody to look for a bill; naming the card sends them to
    // the one screen that fixes it.
    try {
      assertWithinQuota(workspace, limits, { bytes: 1 }, NOW, "past_due");
      throw new Error("expected a throw");
    } catch (err) {
      const message = (err as ApiError).message;
      expect(message).toMatch(/could not take payment/i);
      expect(message).toMatch(/card/i);
      expect(message).toMatch(/readable and downloadable/i);
    }
  });

  it("tells an expired account what is scheduled, and that nothing is gone", () => {
    // Somebody who meets this on a failed upload with no explanation concludes
    // their data has been deleted. It has not, and the message has to say so —
    // together with the fact that paying still undoes it.
    try {
      assertWithinQuota(workspace, limits, { bytes: 1 }, NOW, "expired");
      throw new Error("expected a throw");
    } catch (err) {
      const message = (err as ApiError).message;
      expect(message).toMatch(/scheduled for deletion/i);
      expect(message).toMatch(/nothing has been removed/i);
      expect(message).toMatch(/7-day grace/i);
    }
  });

  it("still allows reads", () => {
    // Locking somebody out of their own files to chase a payment turns a
    // billing problem into a support crisis.
    expect(() => assertWithinQuota(workspace, limits, {}, NOW, "past_due")).not.toThrow();
    expect(() => assertWithinQuota(workspace, limits, {}, NOW, "canceled")).not.toThrow();
    expect(() => assertWithinQuota(workspace, limits, {}, NOW, "expired")).not.toThrow();
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
