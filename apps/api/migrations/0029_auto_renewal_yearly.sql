-- Auto-renewal returns, and a plan can be bought by the year.
--
-- Owner's decision, 25 September 2026, reversing the manual-renewal decision of
-- 23 September. Migration 0027 moved the billing period out of Stripe and into
-- this database because a one-off payment carries no period; this migration
-- moves the authority back. The COLUMNS from 0027 stay exactly as they are —
-- `current_period_end` and `purge_after` are still the things the quota check
-- and the deletion sweep read — but what writes them changes:
--
--   0027   checkout.session.completed computed the period from our own clock
--   0029   customer.subscription.* mirrors the period Stripe already owns
--
-- That is worth stating precisely because the columns look untouched and their
-- meaning is not. `current_period_end` is now a MIRROR. Nothing outside
-- `stripe-webhook.ts` and the console's comp override may compute it, and the
-- renewal job that used to own it is demoted to a reconciler that only catches
-- deliveries Stripe never made.
--
-- Nothing has ever charged on live Stripe and there are zero subscriptions in
-- any environment, so this reversal migrates no customer.
--
-- ── Why the lapse ladder is unchanged ──────────────────────────────────────
-- The three stages from 0027 survive intact: locked at period end, deletion
-- scheduled seven days later, purged seven days after that. What changes is the
-- event that starts them. Under manual renewal day 0 was "nobody bought
-- another month". Under auto-renewal day 0 is "the card failed", and Stripe
-- spends the following days retrying.
--
-- Those two clocks must not run independently. Stripe's default Smart Retries
-- window is roughly three weeks; ours is seven days. Left alone, an account
-- would be locked, scheduled for deletion and purged while Stripe was still
-- collecting — or, inverted, would run free for a fortnight after we should
-- have locked it. **Stripe's retry window is therefore configured to seven
-- days, matching RENEWAL_GRACE_MS**, so dunning and grace are one period seen
-- from two sides. That setting lives in the Stripe dashboard where nothing here
-- can assert it; `lib/renewal.ts` carries the note beside the constant.

-- ── plans: a second price ──────────────────────────────────────────────────
--
-- Columns on the existing row rather than a row per interval, following
-- amardrive's `packages` shape. A plan is one identity — one name, one set of
-- entitlements, one `package_id` that `plan-sync.ts` joins on — sold at two
-- cadences. Splitting it into `pro-monthly` and `pro-yearly` rows would double
-- every entitlement and give two answers to "what plan is this account on".
--
-- NULL means this plan cannot be bought at this interval, which is the state
-- every row starts in and the only state `free` will ever have. `plan-sync.ts`
-- writes both columns from the product's active prices, and checkout refuses an
-- interval whose column is NULL rather than silently selling the other one.
ALTER TABLE plans ADD COLUMN stripe_yearly_price_id TEXT;
ALTER TABLE plans ADD COLUMN amount_cents_yearly INTEGER;

-- `stripe_price_id` keeps its name and keeps meaning the MONTHLY price, rather
-- than being renamed to match its new sibling. Renaming it would touch
-- `findPlanByPriceId`, the catalogue cache, the admin diff, the console screen
-- and eleven tests to express nothing a comment cannot. The asymmetry is the
-- cost of that, and this is where it is written down.
CREATE INDEX idx_plans_stripe_yearly_price ON plans(stripe_yearly_price_id)
  WHERE stripe_yearly_price_id IS NOT NULL;

-- ── organizations: which cadence, and whether it is ending ─────────────────
--
-- 'month' | 'year' | NULL. NULL is every free account and every row predating
-- this migration: nothing was bought, so there is no cadence. It is deliberately
-- nullable rather than defaulting to 'month', because a default would make every
-- free account claim to be on a monthly plan and the billing screen would print
-- a renewal date for a subscription that does not exist.
ALTER TABLE organizations ADD COLUMN billing_interval TEXT;

-- Whether the live subscription is set to stop at the end of the paid period.
--
-- This is the entire difference between "Renews 24 October" and "Ends 24
-- October" on the billing screen, and it cannot be derived from anything else
-- we store: a cancelled-at-period-end subscription is still `active`, still
-- paid up, still entitled to everything it bought. Mirrored from Stripe's
-- `cancel_at_period_end` on every subscription event.
--
-- 0 rather than NULL as the default, because "not cancelling" is a real answer
-- for every existing row and a three-state boolean here buys nothing.
ALTER TABLE organizations ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;

-- ── The dunning stamp ──────────────────────────────────────────────────────
--
-- When the first charge of the current dunning run failed. Cleared the moment
-- any payment succeeds.
--
-- It exists because `billing_status = 'past_due'` says a card is failing but not
-- for how long, and the ladder needs the duration: the lock is immediate, but
-- the deletion schedule is seven days after the failure began, not seven days
-- after whichever hourly tick happened to notice. Without the stamp a redelivered
-- webhook or a restarted dunning run would reset the customer's grace to zero
-- and buy them another week, indefinitely.
--
-- amardrive keeps the same column under the same name (`past_due_since`) for the
-- same reason, and its lock cron reads exactly this.
ALTER TABLE organizations ADD COLUMN past_due_since INTEGER;

CREATE INDEX idx_orgs_past_due_since ON organizations(past_due_since)
  WHERE past_due_since IS NOT NULL;
