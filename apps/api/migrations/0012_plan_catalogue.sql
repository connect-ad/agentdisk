-- The plan catalogue gets the columns it was always missing, and its first rows.
--
-- 0007 created `plans` for 14 PART 29.6 and nothing ever wrote to it. One query
-- reads it — `findPlanByPriceId` — so a paid subscription resolved its price to
-- no plan at all and `organizations.plan` stayed 'free' for somebody who was
-- being charged. The table was a schema for an intention.
--
-- Two things change here. The table gains the entitlements it never carried
-- (agents, members, workspaces, api keys, per-file ceiling), and it gets seeded
-- with the four plans so that a fresh environment enforces the right numbers
-- before anybody has run a Stripe sync.
--
-- ── Three values, three meanings ────────────────────────────────────────────
-- Every limit column here is nullable INTEGER, and the distinction matters
-- because two of the three states look alike at a glance:
--
--   NULL   Not specified by this row. The resolver falls back to the hardcoded
--          tier in lib/plans.ts. This is the safe hole: a half-written row, a
--          column added later, a sync that could not read one metadata key.
--   -1     Unlimited. A decision somebody took, recorded as one.
--   >= 0   The limit.
--
-- NULL could not do double duty as "unlimited" without making a missing value
-- and an infinite one the same thing — which is precisely the direction that
-- silently grants quota nobody agreed to. amardrive shipped that bug in its
-- storage fallback; the shape of this column is the defence against repeating
-- it.
--
-- ── What is authoritative ───────────────────────────────────────────────────
-- Stripe is. These rows are a read cache so the request path never calls the
-- Stripe API, and they are overwritten by `product.created`/`product.updated`
-- and by the staff sync, both of which replay the same upsert. The seed below
-- carries no Stripe ids on purpose: the catalogue has not been created in
-- Stripe at migration time, and inventing ids here would mean D1 pointing at
-- objects that do not exist.

ALTER TABLE plans ADD COLUMN package_id TEXT;
ALTER TABLE plans ADD COLUMN max_file_bytes INTEGER;
ALTER TABLE plans ADD COLUMN agents INTEGER;
ALTER TABLE plans ADD COLUMN members INTEGER;
ALTER TABLE plans ADD COLUMN workspaces INTEGER;
ALTER TABLE plans ADD COLUMN api_keys INTEGER;

-- Display-only. There is nothing on the request path that could enforce a
-- support commitment, and a column that looks like an entitlement but gates
-- nothing is worth labelling as such where it is defined.
ALTER TABLE plans ADD COLUMN priority_support INTEGER NOT NULL DEFAULT 0;

-- Which plan somebody lands on with no subscription.
--
-- Resolved from this column, never from the literal 'free'. amardrive hardcoded
-- its free-tier id, the real ids turned out to carry a product prefix, and the
-- lookup returned null and blanked the account page for everybody on it. The id
-- being 'free' here today does not make hardcoding it correct tomorrow.
ALTER TABLE plans ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

-- Exactly one default, enforced by the database rather than by whoever writes
-- next. A partial index is the whole mechanism: rows with is_default = 0 are
-- not in the index at all, so they do not collide with each other.
CREATE UNIQUE INDEX idx_plans_one_default ON plans(is_default) WHERE is_default = 1;

-- The join key back to Stripe. Unique because two plans claiming one Stripe
-- product would make the sync's upsert non-deterministic — it would depend on
-- row order which of them won.
CREATE UNIQUE INDEX idx_plans_package_id ON plans(package_id) WHERE package_id IS NOT NULL;

-- ── The four plans, as decided 17 September 2026 ────────────────────────────
-- Mirrors infra/stripe-catalogue/catalogue.tf, which is the same table written
-- as Stripe product metadata. The two are kept in step by the sync: Stripe
-- wins, and these values are what holds until the first sync runs.
--
-- Egress, requests and file count are -1 on every plan. R2 egress costs
-- nothing, so it is free to promise; file count is unlimited because storage
-- already bounds it and a second aggregate cap is a second number to contradict.
--
-- `interval` is 'month' even for free, which has no price at all. The column is
-- NOT NULL with that default, and a free plan has no billing interval to
-- describe — it is ignored rather than meaningful for that row.
INSERT INTO plans (
  id, package_id, name, description,
  amount_cents, currency, interval,
  stripe_product_id, stripe_price_id,
  storage_bytes, file_count, egress_bytes_period, requests_period,
  max_file_bytes, agents, members, workspaces, api_keys,
  priority_support, is_public, is_default, sort_order,
  created_at, updated_at
) VALUES
  (
    'free', 'agentdisk-free', 'Free',
    'One workspace, one agent identity, 1 GB. No card required.',
    0, 'usd', 'month',
    NULL, NULL,
    1073741824, -1, -1, -1,
    104857600, 1, 1, 1, 2,
    0, 1, 1, 10,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'basic', 'agentdisk-basic', 'Basic',
    'Three workspaces and five agent identities, for a single developer running more than a demo.',
    900, 'usd', 'month',
    NULL, NULL,
    5368709120, -1, -1, -1,
    524288000, 5, 2, 3, 6,
    0, 1, 0, 20,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'pro', 'agentdisk-pro', 'Pro',
    'Ten workspaces, ten agent identities and 50 GB, with priority support.',
    2000, 'usd', 'month',
    NULL, NULL,
    53687091200, -1, -1, -1,
    1073741824, 10, 5, 10, 20,
    1, 1, 0, 30,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'team', 'agentdisk-team', 'Team',
    'Fifty workspaces, fifty agent identities and 500 GB, for a team running agents in production.',
    8000, 'usd', 'month',
    NULL, NULL,
    536870912000, -1, -1, -1,
    5368709120, 50, 25, 50, 100,
    1, 1, 0, 40,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  );
