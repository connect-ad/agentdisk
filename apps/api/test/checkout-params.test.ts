/**
 * The Checkout Session's parameters, as a value.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * `checkout.test.ts` is entirely refusals, and that is correct: the happy path
 * ends in an outbound Stripe call, and a suite that really made one would be
 * talking to Stripe on every run. But it leaves a blind spot exactly the shape
 * of the session object — and that blind spot has now shipped **two** defects
 * that made every purchase in the product fail, with the suite green both
 * times:
 *
 *   23 Sept   a recurring price passed to `mode: "payment"`. Stripe refuses a
 *             recurring price there. Found from a screenshot of the Stripe
 *             dashboard, not from a test.
 *   25 Sept   `automatic_tax` enabled against an existing `customer` with no
 *             `customer_update`. Stripe refuses that too. Found from a
 *             screenshot of the error, not from a test.
 *
 * Pulling the object out of the call site makes it an ordinary value. These are
 * ordinary assertions on it.
 *
 * ── What this cannot prove ─────────────────────────────────────────────────
 * That Stripe *accepts* the combination. Only a live session does that. Neither
 * defect above was a test that was wrong; they were tests that did not exist,
 * and this file closes the gap one level below the network rather than
 * pretending to cross it.
 */

import { describe, expect, it } from "vitest";
import { checkoutSessionParams } from "../src/routes/billing";

const params = () =>
  checkoutSessionParams({
    priceId: "price_pro_month",
    customerId: "cus_live",
    orgId: "org_TESTORG",
    planId: "pro",
    workspacePath: "https://app-dev.agentdisk.io/w/acme/billing",
  });

describe("the two failures this file was written for", () => {
  it("asks Stripe to write the collected address back to the customer", () => {
    // **The 25 September outage.** Stripe refuses a session that enables
    // `automatic_tax` against an existing customer unless it is also told it
    // may update that customer's address — it has to compute tax from an
    // address, the customer object is where one lives, and it will not
    // silently use a stale one or silently ignore the field.
    //
    // Every account reaches checkout with a customer already created, because
    // `ensureCustomer` makes one before the session. So this was not an edge
    // case; it was the only path.
    const session = params();

    expect(session.automatic_tax).toEqual({ enabled: true });
    expect(session.customer).toBe("cus_live");
    expect(session.customer_update?.address).toBe("auto");
  });

  it("creates a subscription, which is the mode a recurring price needs", () => {
    // **The 23 September outage, in the other direction.** The price type and
    // the checkout mode are one contract: Stripe refuses a recurring price in
    // `mode: "payment"` exactly as it refuses a one-time price here. The
    // catalogue selects recurring prices (`plan-sync.ts`), so this must stay
    // `subscription` or the pair comes apart again.
    expect(params().mode).toBe("subscription");
  });
});

describe("what a purchase has to carry", () => {
  it("names our plan through a price the server resolved, never one a client sent", () => {
    const session = params();
    expect(session.line_items).toEqual([{ price: "price_pro_month", quantity: 1 }]);
  });

  it("can be traced back to an account from either the session or the subscription", () => {
    // Both, deliberately. A support engineer reading a Stripe event should not
    // have to match on an email that may be shared between accounts — and the
    // subscription outlives the session, so metadata on the session alone
    // would be gone by the first renewal.
    const session = params();
    expect(session.client_reference_id).toBe("org_TESTORG");
    expect(session.metadata).toEqual({
      agentdisk_org_id: "org_TESTORG",
      agentdisk_plan: "pro",
    });
    expect(session.subscription_data?.metadata).toEqual({
      agentdisk_org_id: "org_TESTORG",
      agentdisk_plan: "pro",
    });
  });

  it("collects the address, which is the part that cannot be recovered later", () => {
    // A charge taken without an address is a charge whose tax jurisdiction has
    // to be reconstructed from Stripe a year afterwards, if it can be
    // established at all. EU rules for digital services want two
    // non-contradictory pieces of evidence of where the customer is.
    expect(params().billing_address_collection).toBe("required");
  });

  it("lets a business enter a VAT number", () => {
    // Without the field a B2B customer simply absorbs the tax, which is the
    // quiet reason they do not come back.
    expect(params().tax_id_collection).toEqual({ enabled: true });
  });

  it("lets a promo code be typed on Stripe's page", () => {
    // Codes are redeemed there rather than validated here — Stripe refuses
    // `discounts` and `allow_promotion_codes` together, and Stripe's own
    // redemption counting is atomic where ours would not be.
    expect(params().allow_promotion_codes).toBe(true);
  });

  it("returns to the workspace it started from, saying which way it went", () => {
    const session = params();
    expect(session.success_url).toBe(
      "https://app-dev.agentdisk.io/w/acme/billing?checkout=success"
    );
    expect(session.cancel_url).toBe(
      "https://app-dev.agentdisk.io/w/acme/billing?checkout=cancelled"
    );
  });

  it("carries no card-shaped field of any kind", () => {
    // The rule that keeps AgentDisk in PCI SAQ-A. Nothing here may name a card,
    // because naming one is the first step towards collecting one.
    const text = JSON.stringify(params());
    expect(text).not.toMatch(/card_number|payment_method_data|cvc|exp_month|last4/i);
  });
});
