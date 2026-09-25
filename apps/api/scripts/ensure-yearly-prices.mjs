#!/usr/bin/env node
/**
 * Mint the yearly price for any plan that is sold monthly and has none.
 *
 * Runs on every backend deploy. Adds prices; never edits one, never archives
 * one, never touches a product.
 *
 * ── Why this is a script and not the Terraform root that used to be here ───
 * `infra/stripe-catalogue/` created the four products and their monthly prices
 * and was deleted on 18 September 2026 (commit 7478e12) for a specific reason:
 * **Terraform held no state for those products.** The next apply would have
 * created a SECOND set of four carrying the same `package_id`s, and the
 * catalogue sync takes whichever was written last. The module was not wrong
 * about Stripe; it had simply lost the only record of what it had already done.
 *
 * So the thing to fix is not the tool, it is where idempotency comes from.
 * This script does not keep state at all. It asks Stripe the question that
 * actually matters — *does this product already have an active yearly price?*
 * — and acts only when the answer is no. Run it a hundred times and the
 * hundredth is a no-op, with no state file to lose, corrupt or apply from the
 * wrong workspace.
 *
 * ── Why it checks for a yearly price rather than a lookup key ──────────────
 * `lookup_key` would be the obvious handle, and it is the wrong one. Stripe
 * requires it to be unique among *active* prices and frees it when a price is
 * archived — so after an operator raises the yearly price in the console (which
 * mints a new price and archives the old, because a Stripe price is immutable),
 * the old key is available again and a key-based check would cheerfully
 * re-create the superseded price at the old amount. Asking "is there an active
 * yearly price on this product" cannot make that mistake.
 *
 * ── What it will not do ────────────────────────────────────────────────────
 * Change a price. A Stripe price is immutable, so "changing" one means minting
 * a replacement and archiving the original, which re-prices nobody but does
 * decide what new customers pay. That is a commercial decision and it belongs
 * to a person in the admin console, not to a deploy step that runs on every
 * push.
 */

const API = "https://api.stripe.com/v1";

/** Every product of ours carries this prefix in `package_id`. Nothing else is ours. */
const PACKAGE_PREFIX = "agentdisk-";

/**
 * The yearly discount, and the rounding.
 *
 * Down to the whole dollar, so the advertised "save 15%" is never an
 * over-claim: $9/month gives $91.80, which becomes $91 and a real saving of
 * 15.7%. Rounding up would print a 15% badge over a 14.8% discount.
 *
 * Kept in step with `YEARLY_DISCOUNT` in `apps/api/src/lib/renewal.ts` and the
 * figures in `apps/web/src/lib/pricing.js`. Three copies, and this is the one
 * that actually charges people.
 */
const YEARLY_DISCOUNT = 0.15;

function yearlyCents(monthlyCents) {
  return Math.floor((monthlyCents * 12 * (1 - YEARLY_DISCOUNT)) / 100) * 100;
}

const key = process.env.STRIPE_SECRET_KEY;
const dryRun = process.argv.includes("--dry-run");

if (!key) {
  // Not a failure. An environment without a Stripe key cannot sell anything,
  // and failing the deploy over it would block every other environment's
  // pipeline for a reason that has nothing to do with the code being deployed.
  console.log("No STRIPE_SECRET_KEY; skipping yearly price check.");
  process.exit(0);
}

async function stripe(path, { method = "GET", form } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      // Pinned to match the Worker's own client. An unpinned script reads
      // whatever the account default is, and the two would eventually disagree
      // about a field shape without anybody changing either.
      "stripe-version": "2026-08-26.dahlia",
    },
    ...(form ? { body: form } : {}),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe ${method} ${path} → ${res.status}: ${body?.error?.message ?? "unknown"}`);
  }
  return body;
}

const isOurs = product => (product.metadata?.package_id ?? "").startsWith(PACKAGE_PREFIX);

/** A price we actually sell at: recurring, at this interval, one period at a time. */
const soldAt = (price, interval) =>
  price.recurring?.interval === interval && price.recurring?.interval_count === 1;

const products = await stripe("/products?active=true&limit=100");

let created = 0;
let already = 0;
let skipped = 0;

for (const product of products.data) {
  if (!isOurs(product)) {
    skipped += 1;
    continue;
  }

  const planId = product.metadata?.plan_id ?? product.metadata.package_id.slice(PACKAGE_PREFIX.length);
  const prices = await stripe(`/prices?product=${product.id}&active=true&limit=100`);

  const monthly = prices.data.find(price => soldAt(price, "month"));
  const yearly = prices.data.find(price => soldAt(price, "year"));

  if (yearly) {
    already += 1;
    console.log(`  ${planId}: yearly already exists (${yearly.id}, ${yearly.unit_amount})`);
    continue;
  }

  if (!monthly || !monthly.unit_amount) {
    // Free has no price by design — a $0 subscription can go past_due and dun
    // somebody for nothing — and a paid plan with no monthly price has no
    // figure to derive a yearly one from. Either way there is nothing to do,
    // and inventing an amount would be this script making a pricing decision.
    skipped += 1;
    console.log(`  ${planId}: no monthly price to derive from; leaving alone`);
    continue;
  }

  const amount = yearlyCents(monthly.unit_amount);

  if (dryRun) {
    console.log(`  ${planId}: WOULD create yearly at ${amount} (from ${monthly.unit_amount}/month)`);
    created += 1;
    continue;
  }

  const form = new URLSearchParams({
    product: product.id,
    currency: monthly.currency,
    unit_amount: String(amount),
    "recurring[interval]": "year",
    "recurring[interval_count]": "1",
    // Required once automatic tax is on. A price declaring neither inclusive
    // nor exclusive cannot be calculated on, and the Checkout Session fails
    // outright rather than quietly under-taxing.
    tax_behavior: "exclusive",
    nickname: `${product.name} — yearly`,
    lookup_key: `${PACKAGE_PREFIX}${planId}-yearly`,
    "metadata[package_id]": product.metadata.package_id,
    "metadata[plan_id]": planId,
    "metadata[interval]": "year",
  });

  const price = await stripe("/prices", { method: "POST", form });
  created += 1;
  console.log(`  ${planId}: created yearly ${price.id} at ${amount} (${monthly.unit_amount}/month)`);
}

console.log(
  `Yearly prices — created ${created}, already present ${already}, skipped ${skipped}` +
    (dryRun ? " (dry run)" : "")
);
