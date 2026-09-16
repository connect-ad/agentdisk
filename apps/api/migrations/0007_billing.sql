-- Stripe billing — 14 PART 29.2, 29.6.
--
-- Billing belongs to the organization, not the workspace: one account, one
-- card, one invoice, covering every workspace under it. That was a deliberate
-- product decision, and it is why nothing here hangs off `workspaces`.

-- 'active' | 'past_due' | 'canceled'.
--
-- Checked in the quota step of the authorization chain (06 PART 16.1 step 5),
-- where it blocks writes while leaving reads working. Somebody whose card
-- expired must still be able to get their data out - locking them out of their
-- own files to chase a payment is how a billing problem becomes a support
-- crisis and a reputation for holding data hostage.
ALTER TABLE organizations ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'active';

-- Stripe's own identifier for the subscription, so a webhook naming one can be
-- resolved back to an organization without a scan. `stripe_customer_id` already
-- exists on organizations from 0002.
ALTER TABLE organizations ADD COLUMN stripe_subscription_id TEXT;

CREATE INDEX idx_organizations_stripe_customer ON organizations(stripe_customer_id);
CREATE INDEX idx_organizations_stripe_subscription ON organizations(stripe_subscription_id);

-- The plans an admin can edit, and their Stripe counterparts (29.6).
--
-- Deliberately a table rather than the hardcoded `lib/plans.ts` limits: the
-- point of 29.6 is that pricing changes without a deploy. `lib/plans.ts` stays
-- as the *enforcement* floor - a row here that fails to load must never widen
-- somebody's quota, so the code resolves anything it cannot read to the
-- tightest plan.
CREATE TABLE plans (
  -- 'free' | 'pro' | ... . Matches organizations.plan, which is what the quota
  -- check reads, so a plan row and a subscription cannot disagree about a name.
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  -- Minor units, matching Stripe. Storing 19.00 as a float would eventually
  -- bill somebody 18.999999.
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  interval TEXT NOT NULL DEFAULT 'month',
  -- Stripe's product and the *current* price. A price is immutable in Stripe,
  -- so changing an amount creates a new one and moves this pointer; the old
  -- price stays alive for everybody already subscribed to it.
  stripe_product_id TEXT,
  stripe_price_id TEXT,
  -- Quota limits, mirroring 07 PART 19.0 so an admin can change them with the
  -- price rather than needing a deploy to match the two up.
  storage_bytes INTEGER,
  file_count INTEGER,
  egress_bytes_period INTEGER,
  requests_period INTEGER,
  is_public INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_plans_stripe_price ON plans(stripe_price_id);
