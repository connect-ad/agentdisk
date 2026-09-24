/**
 * The manual-renewal clock — owner's decision, 23 September 2026.
 *
 * AgentDisk does not auto-renew. A purchase buys one month; when it ends the
 * account locks, and a week after that its data is scheduled for deletion. The
 * three moments and the arithmetic that produces them live here rather than in
 * the job, because the quota refusal, the emails, the dashboard's dates and the
 * sweep all have to agree about them — and four copies of "seven days" is three
 * chances to disagree.
 *
 * ```
 * day -7          day 0 (expiry)        day +7
 *   |                  |                   |
 *   o----------------->o==================>X
 *   |                  |   grace           |
 * reminder        write lock          deletion
 * email           + email             scheduled + email
 * ```
 *
 * Reads, lists and downloads work the whole way through. Nothing is deleted
 * before day +7, and day +7 only *schedules* it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long before a period ends that we warn. */
export const RENEWAL_REMINDER_MS = 7 * DAY_MS;

/**
 * How long an expired account keeps its data before deletion is scheduled.
 *
 * Writes are already blocked for this whole window — the grace is about the
 * data, not about the service. Somebody who comes back on day six renews and
 * loses nothing.
 */
export const RENEWAL_GRACE_MS = 7 * DAY_MS;

/**
 * How long "scheduled for deletion" actually lasts.
 *
 * Without this the stamp was already in the past the moment it was written —
 * the scheduling pass fires at `periodEnd + GRACE` and wrote `purge_after` to
 * that same instant — so the third email would have said "scheduled" and the
 * bytes would have gone on the next hourly tick. That is a deletion with a
 * simultaneous notification, not a schedule.
 *
 * Seven days, matching the window Privacy clause 12 already publishes for a
 * deleted workspace or account. One retention number in the product rather than
 * two, so "when is it really gone" has one answer.
 */
export const RENEWAL_NOTICE_MS = 7 * DAY_MS;

/** One purchase buys this much service. */
export const BILLING_PERIOD_MONTHS = 1;

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
 * Where a purchase made now should end.
 *
 * Extends from the existing period end when one is still in the future, so
 * renewing early adds a month rather than throwing away the days already paid
 * for. The day −7 reminder exists precisely to make people buy before their
 * period ends, so this is the ordinary case, not an edge one.
 */
export function nextPeriodEnd(now: number, currentPeriodEnd: number | null): number {
  const base = currentPeriodEnd !== null && currentPeriodEnd > now ? currentPeriodEnd : now;
  return addMonths(base, BILLING_PERIOD_MONTHS);
}

/** When an account that expired at `periodEnd` has its data scheduled for deletion. */
export function deletionScheduledAt(periodEnd: number): number {
  return periodEnd + RENEWAL_GRACE_MS;
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
