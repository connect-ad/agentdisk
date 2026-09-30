/**
 * The renewal clock — owner's decision, 25 September 2026.
 *
 * AgentDisk auto-renews. A subscription bills itself; when a charge fails the
 * account locks, and if Stripe cannot collect within the grace window the data
 * is scheduled for deletion. The three moments and the arithmetic that produces
 * them live here rather than in the job, because the quota refusal, the emails,
 * the dashboard's dates and the sweep all have to agree about them — and four
 * copies of "seven days" is three chances to disagree.
 *
 * ```
 * day -7            day 0                day +7           day +14
 *   |                 |                    |                 |
 *   o---------------->o===================>o================>X
 *   |                 |   grace = dunning  |                 |
 * "renews on X    charge failed        Stripe gives up    purged
 *  for $Y"        → past_due           → expired
 *                 → write lock         → purge_after
 * ```
 *
 * Reads, lists and downloads work the whole way through. Nothing is deleted
 * before day +14, and day +7 only *schedules* it. Any successful payment at any
 * point returns the account to `active` and clears the stamp.
 *
 * ── What changed when auto-renewal came back ───────────────────────────────
 * Until 25 September this module OWNED the period: a one-off payment carries no
 * renewal date, so `nextPeriodEnd` computed one and `checkout.session.completed`
 * wrote it. Stripe owns it again. `organizations.current_period_end` is now a
 * mirror of `subscription.current_period_end`, written only by the webhook, and
 * `addMonths` survives for the one caller that still has to invent a period —
 * the console granting a comped plan to an account with no subscription.
 *
 * The ladder below is unchanged from the manual-renewal design. Only its day 0
 * moved: it used to mean "nobody bought another month" and now means "the card
 * failed".
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long before a period ends that we give notice of the renewal charge. */
export const RENEWAL_REMINDER_MS = 7 * DAY_MS;

/**
 * How long a failing account keeps its data before deletion is scheduled.
 *
 * Writes are already blocked for this whole window — the grace is about the
 * data, not about the service. Somebody whose card clears on day six loses
 * nothing.
 *
 * ── This number is also a Stripe setting, and they must match ──────────────
 * Under auto-renewal the grace window runs concurrently with Stripe's own
 * dunning: Stripe is retrying the card for exactly as long as we are holding
 * the data. Stripe's default Smart Retries schedule spans roughly three weeks,
 * which would purge an account eleven days before Stripe stopped trying to
 * collect from it — deleting a customer's files while their payment was still
 * in flight.
 *
 * So **Billing → Subscriptions → Manage failed payments is configured to retry
 * for 7 days and then cancel the subscription.** Nothing in this repository can
 * assert that; it lives in the Stripe dashboard, in the same category as the
 * webhook endpoint's subscribed event list. If somebody widens it, this constant
 * must widen with it or the two clocks come apart silently.
 */
export const RENEWAL_GRACE_MS = 7 * DAY_MS;

/**
 * How long "scheduled for deletion" actually lasts.
 *
 * Without this the stamp was already in the past the moment it was written —
 * the scheduling pass fires at `pastDueSince + GRACE` and wrote `purge_after` to
 * that same instant — so the third email would have said "scheduled" and the
 * bytes would have gone on the next hourly tick. That is a deletion with a
 * simultaneous notification, not a schedule.
 *
 * Seven days, matching the window Privacy clause 12 already publishes for a
 * deleted workspace or account. One retention number in the product rather than
 * two, so "when is it really gone" has one answer.
 */
export const RENEWAL_NOTICE_MS = 7 * DAY_MS;

/** The two cadences a plan can be sold at. */
export type BillingInterval = "month" | "year";

/** How many months one period of each cadence buys. */
export function monthsForInterval(interval: BillingInterval): number {
  return interval === "year" ? 12 : 1;
}

/** Is this a cadence we sell? Anything else is a caller's typo, not a new plan. */
export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === "month" || value === "year";
}

/**
 * The yearly discount, as a fraction of twelve months at the monthly price.
 *
 * Here rather than only in the catalogue because the dashboard advertises it
 * ("save 15%") and the admin console's price form offers it as the default when
 * minting a yearly price. Two places quoting a discount is one chance to quote
 * different ones.
 *
 * It is advisory: the authoritative yearly figure is `plans.amount_cents_yearly`,
 * whatever an operator actually set. `yearlyDiscountPercent` below reports the
 * real saving from the two stored amounts, and that is what the screen shows.
 */
export const YEARLY_DISCOUNT = 0.15;

/**
 * The suggested yearly amount for a monthly price, rounded DOWN to the dollar.
 *
 * Down rather than to-nearest so the advertised "save 15%" is never an
 * over-claim: $9/month gives $91.80, which becomes $91 and a real saving of
 * 15.7%. Rounding up would print a 15% badge over a 14.8% discount.
 */
export function suggestedYearlyCents(monthlyCents: number): number {
  const full = monthlyCents * 12 * (1 - YEARLY_DISCOUNT);
  return Math.floor(full / 100) * 100;
}

/** What a customer actually saves by paying yearly, as a whole percent. */
export function yearlyDiscountPercent(
  monthlyCents: number,
  yearlyCents: number
): number | null {
  if (monthlyCents <= 0 || yearlyCents <= 0) return null;
  const full = monthlyCents * 12;
  if (yearlyCents >= full) return null;
  return Math.round(((full - yearlyCents) / full) * 100);
}

/**
 * Add whole months, clamping rather than overflowing.
 *
 * `setUTCMonth` rolls a 31st into the next month — 31 January plus one month
 * becomes 3 March, and the billing date then drifts forward every period until
 * it settles on the 28th of something. Clamping to the last day of the target
 * month keeps a purchase on the 31st renewing on the 28th/29th/30th/31st as the
 * calendar allows, which is what Stripe does and what a customer reading their
 * own renewal date expects.
 */
export function addMonths(from: number, months: number): number {
  const start = new Date(from);
  const day = start.getUTCDate();

  const end = new Date(from);
  end.setUTCDate(1); // so the month change cannot overflow on its own
  end.setUTCMonth(end.getUTCMonth() + months);

  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));

  return end.getTime();
}

/**
 * Where a period granted now should end.
 *
 * **Only for a period Stripe is not providing.** A real subscription carries its
 * own `current_period_end` and the webhook mirrors it; this is for the console
 * comping an account that has no subscription at all, where somebody has to
 * decide when the grant runs out and the alternative is a plan that never ends.
 *
 * Extends from the existing period end when one is still in the future, so a
 * grant stacked on a live period adds to it rather than throwing away days
 * already paid for.
 */
export function grantedPeriodEnd(
  now: number,
  currentPeriodEnd: number | null,
  interval: BillingInterval = "month"
): number {
  const base = currentPeriodEnd !== null && currentPeriodEnd > now ? currentPeriodEnd : now;
  return addMonths(base, monthsForInterval(interval));
}

/**
 * When an account whose payment failed at `pastDueSince` has its data scheduled
 * for deletion.
 *
 * Anchored on the failure rather than on the period end, and the two are not the
 * same moment. A subscription can fail its charge days after the period boundary
 * — Stripe raises the invoice, attempts it, and only then reports the failure —
 * and anchoring on the boundary would shorten somebody's grace by however long
 * that took.
 */
export function deletionScheduledAt(pastDueSince: number): number {
  return pastDueSince + RENEWAL_GRACE_MS;
}

/** A date as the emails and the dashboard both write it: "14 October 2026". */
export function formatPeriodDate(at: number): string {
  return new Date(at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** An amount in minor units as a price is printed: 20400 -> "$204.00". */
export function formatAmount(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}
