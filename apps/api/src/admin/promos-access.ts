/**
 * Promotion codes — the console's discount surface.
 *
 * ── There is no promo table, and that is the design ─────────────────────────
 * Stripe owns discounts outright. A **Coupon** is the discount itself — percent
 * or fixed amount, lasting once, forever, or a number of months. A **Promotion
 * Code** is the human-typed string bound to that coupon, carrying the
 * restrictions: how many times it may be redeemed, when it expires, whether it
 * belongs to one customer.
 *
 * Mirroring that into D1 would buy nothing and cost the hardest problem in the
 * feature. Stripe counts redemptions atomically at the moment of payment, so
 * two people racing to claim the last use of a code cannot both win. A local
 * counter would have to reproduce that against a database that is not on the
 * payment path and cannot see the charge succeed. amardrive reached the same
 * conclusion and deleted a home-grown promo implementation to get here.
 *
 * So this class is a thin, audited UI over Stripe's API, in the same spirit as
 * `admin/billing-access.ts`: nothing is cached, nothing is a second source of
 * truth, and a failed upstream read is reported as unavailable rather than as
 * an empty list.
 *
 * ── Redemption is not implemented here, deliberately ────────────────────────
 * Checkout passes `allow_promotion_codes: true`, so the customer types the code
 * on Stripe's own payment page and Stripe validates and applies it. This file
 * only creates and retires codes. Validating one on our side would mean passing
 * `discounts` at checkout instead — and **Stripe rejects `discounts` and
 * `allow_promotion_codes` together**, so that is a trade, not an addition: the
 * free-text field on Stripe's page would have to go.
 */

import { AuditedAdminAccess } from "./audited";
import { validationError } from "../lib/errors";
import type { Stripe } from "../billing/stripe";

/** What the console renders for one code. */
export interface PromoRow {
  id: string;
  code: string;
  active: boolean;
  /** Exactly one of these two is set, mirroring Stripe's own coupon shape. */
  percentOff: number | null;
  amountOffCents: number | null;
  currency: string | null;
  duration: string;
  durationMonths: number | null;
  /** Null means unlimited — a real decision, not a missing value. */
  maxRedemptions: number | null;
  timesRedeemed: number;
  expiresAt: number | null;
  createdAt: number;
  /** Who made it, from coupon metadata. Null for a code created in Stripe. */
  createdBy: string | null;
  /** True when the code only works on a customer's first purchase. */
  firstTimeOnly: boolean;
}

export interface CreatePromoInput {
  code: string;
  percentOff?: number;
  amountOffCents?: number;
  currency?: string;
  duration: "once" | "forever" | "repeating";
  durationMonths?: number;
  /**
   * Undefined is unlimited; 1 is a single-use code. The console's form says
   * which in words rather than leaving an empty box to mean "no limit" — that
   * ambiguity is the same one `NULL` versus `-1` in `plans` already rules out.
   */
  maxRedemptions?: number;
  expiresAt?: number;
  /**
   * One promo per account, ever — the owner's rule (24 Sept 2026).
   *
   * Stripe enforces this natively as `restrictions.first_time_transaction`: the
   * code applies only to a customer with no prior successful payment. So a
   * promo works on somebody's first purchase and never again, for any code.
   *
   * It has to be Stripe's check rather than ours, because customers type codes
   * on Stripe's own page (`allow_promotion_codes`) and this product never sees
   * one before the charge. A local redemption table could not be consulted at
   * the moment that matters.
   *
   * Defaults to true. Turning it off is the deliberate act, not leaving it on.
   */
  firstTimeOnly?: boolean;
}

/**
 * A code has to be typeable and unambiguous.
 *
 * Uppercased before the check rather than after, so `welcome50` and `WELCOME50`
 * cannot both exist — Stripe treats the code case-insensitively at redemption
 * but stores what it was given, and two rows differing only in case would look
 * like two codes and behave like one.
 */
const CODE_PATTERN = /^[A-Z0-9_-]{4,32}$/;


/**
 * The coupon behind a promotion code, or null.
 *
 * API version `2026-08-26.dahlia` moved the coupon from `promo.coupon` to
 * `promo.promotion.coupon`, and typed it as a string when it is not expanded.
 * Both facts are version-specific, so both are handled in one place: the client
 * pins its API version (`billing/stripe.ts`), and when that pin next moves this
 * is the one function that has to be looked at.
 *
 * An unexpanded coupon yields null rather than a cast. The row then reports no
 * discount, which is visibly wrong on screen — better than a plausible zero
 * that reads as "no discount" and is actually "we did not ask".
 */
function couponOf(promo: Stripe.PromotionCode): Stripe.Coupon | null {
  const coupon = promo.promotion?.coupon;
  if (coupon === null || coupon === undefined || typeof coupon === "string") return null;
  return coupon;
}

/** One Stripe promotion code, as the console reads it. */
function toRow(promo: Stripe.PromotionCode): PromoRow {
  const coupon = couponOf(promo);
  return {
    id: promo.id,
    code: promo.code,
    active: promo.active,
    percentOff: coupon?.percent_off ?? null,
    amountOffCents: coupon?.amount_off ?? null,
    currency: coupon?.currency ?? null,
    duration: coupon?.duration ?? "once",
    durationMonths: coupon?.duration_in_months ?? null,
    maxRedemptions: promo.max_redemptions ?? null,
    timesRedeemed: promo.times_redeemed,
    expiresAt: promo.expires_at === null ? null : promo.expires_at * 1000,
    createdAt: promo.created * 1000,
    createdBy: coupon?.metadata?.["created_by"] ?? null,
    firstTimeOnly: promo.restrictions?.first_time_transaction === true,
  };
}

export class AdminPromoAccess extends AuditedAdminAccess {
  /**
   * Every promotion code Stripe holds.
   *
   * The coupon is expanded rather than fetched per row: a screen listing forty
   * codes would otherwise make forty-one requests, and Stripe's rate limit is
   * the sort of thing discovered in production.
   */
  async list(stripe: Stripe): Promise<{ promos: PromoRow[] }> {
    await this.requireRole("admin", "read promotion codes");

    const page = await stripe.promotionCodes.list({
      limit: 100,
      expand: ["data.promotion.coupon"],
    });

    const promos = page.data.map(toRow);

    await this.recordFleet({ action: "promo.view", metadata: { count: promos.length } });
    return { promos };
  }

  /**
   * Create a coupon and the code that redeems it.
   *
   * Two Stripe objects, in that order, because a promotion code cannot exist
   * without a coupon to point at. If the second call fails the coupon is left
   * behind unreferenced — harmless, invisible to customers, and cheaper than
   * the alternative of deleting it on a failure path that may itself fail.
   */
  async create(stripe: Stripe, input: CreatePromoInput): Promise<PromoRow> {
    await this.requireRole("admin", "create a promotion code");

    const code = input.code.trim().toUpperCase();
    if (!CODE_PATTERN.test(code)) {
      throw validationError(
        "A code is 4 to 32 characters, using letters, numbers, dashes and underscores only."
      );
    }

    const hasPercent = input.percentOff !== undefined;
    const hasAmount = input.amountOffCents !== undefined;
    if (hasPercent === hasAmount) {
      // Both or neither. Stripe refuses both too, but with a message written
      // for somebody reading API docs rather than somebody filling in a form.
      throw validationError("Give either a percentage off or a fixed amount off, not both.");
    }
    if (hasPercent && (input.percentOff! <= 0 || input.percentOff! > 100)) {
      throw validationError("A percentage off is between 1 and 100.");
    }
    if (hasAmount && input.amountOffCents! <= 0) {
      throw validationError("A fixed amount off must be more than zero.");
    }
    if (hasAmount && (input.currency === undefined || input.currency === "")) {
      throw validationError("A fixed amount off needs a currency.");
    }
    if (input.duration === "repeating" && input.durationMonths === undefined) {
      throw validationError("A repeating discount needs a number of months.");
    }
    if (input.duration !== "repeating" && input.durationMonths !== undefined) {
      // Silently ignoring it would let somebody believe they had set a length
      // on a `forever` coupon.
      throw validationError("A number of months only applies to a repeating discount.");
    }
    if (input.maxRedemptions !== undefined && input.maxRedemptions < 1) {
      throw validationError("A redemption limit is at least 1. Leave it empty for unlimited.");
    }
    // A code that gives the product away permanently to everybody is one
    // careless form submission, and nothing downstream would catch it: there is
    // no approval step, no cap, and the audit row is written after the fact.
    // So the deepest discounts must be bounded in at least one dimension.
    if (input.percentOff === 100 && input.duration !== "once") {
      throw validationError(
        "A 100% discount can only apply to the first payment. Choose 'the first payment only', or reduce the percentage."
      );
    }
    if (
      (input.percentOff ?? 0) >= 50 &&
      input.duration === "forever" &&
      input.maxRedemptions === undefined
    ) {
      throw validationError(
        "A discount of 50% or more lasting forever needs a redemption limit. Set how many times it can be used."
      );
    }
    if (input.expiresAt !== undefined && input.expiresAt <= this.now) {
      throw validationError("An expiry date has to be in the future.");
    }

    const coupon = await stripe.coupons.create({
      name: code,
      ...(hasPercent
        ? { percent_off: input.percentOff! }
        : { amount_off: input.amountOffCents!, currency: input.currency! }),
      duration: input.duration,
      ...(input.duration === "repeating" ? { duration_in_months: input.durationMonths! } : {}),
      // Stamped so a code can be traced to a person from the Stripe dashboard
      // alone, without anybody having to cross-reference our audit log.
      metadata: { created_by: this.admin.email, created_via: "agentdisk-console" },
    });

    const promo = await stripe.promotionCodes.create({
      // Nested since API version 2026-08-26.dahlia, which this client pins.
      promotion: { type: "coupon", coupon: coupon.id },
      code,
      ...(input.maxRedemptions === undefined
        ? {}
        : { max_redemptions: input.maxRedemptions }),
      ...(input.expiresAt === undefined
        ? {}
        : { expires_at: Math.floor(input.expiresAt / 1000) }),
      // One promo per account, ever. Defaults ON — see `firstTimeOnly`.
      ...(input.firstTimeOnly === false
        ? {}
        : { restrictions: { first_time_transaction: true } }),
    });

    await this.recordFleet({
      action: "promo.create",
      targetType: "promotion_code",
      targetId: promo.id,
      metadata: {
        code,
        percentOff: input.percentOff ?? null,
        amountOffCents: input.amountOffCents ?? null,
        duration: input.duration,
        durationMonths: input.durationMonths ?? null,
        // Spelled out rather than left as an absent key, because "unlimited" is
        // the fact an auditor is looking for.
        maxRedemptions: input.maxRedemptions ?? "unlimited",
        // Spelled out for the same reason as the line above: "no expiry" is a
        // decision somebody made, and an absent key reads as "not recorded".
        expiresAt: input.expiresAt === undefined
          ? "never"
          : new Date(input.expiresAt).toISOString(),
        firstTimeOnly: input.firstTimeOnly !== false,
      },
    });

    // Built from the coupon this call just created rather than from the
    // promotion code, whose `promotion.coupon` comes back as a bare id.
    return {
      ...toRow(promo),
      percentOff: coupon.percent_off ?? null,
      amountOffCents: coupon.amount_off ?? null,
      currency: coupon.currency ?? null,
      duration: coupon.duration,
      durationMonths: coupon.duration_in_months ?? null,
      createdBy: this.admin.email,
    };
  }

  /**
   * Stop a code working, without removing it.
   *
   * Stripe does not allow deleting a promotion code at all, and deactivation is
   * the right semantic regardless: the discounts already redeemed under it stay
   * attached to real customers, and a code that vanished would leave those
   * unexplained on an invoice somebody queries a year later.
   */
  async deactivate(stripe: Stripe, promoId: string, reason: string): Promise<PromoRow> {
    await this.requireRole("admin", "deactivate a promotion code");

    const promo = await stripe.promotionCodes.update(promoId, { active: false });

    await this.recordFleet({
      action: "promo.deactivate",
      targetType: "promotion_code",
      targetId: promo.id,
      reason,
      metadata: { code: promo.code, timesRedeemed: promo.times_redeemed },
    });

    return toRow(promo);
  }
}
