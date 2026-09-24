-- The end of the account lifecycle — 24 September 2026.
--
-- Migration 0027 gave this product a clock it owns and a `purge_after` stamp.
-- What it did not give it was an ending: the stamp was written by the renewal
-- ladder and read by nothing that acts, so the third lifecycle email promised a
-- deletion no code performed. This column is what the deletion leaves behind.
--
-- **Why the organization row survives its own purge.** The alternative is
-- deleting it, and that loses two things worth keeping. The audit trail stops
-- resolving — `admin_actions` and `audit_events` name an org that no longer
-- exists. And the person can still sign in, because `users` is untouched, so
-- they would land in a product that had silently re-bootstrapped them a fresh
-- free workspace with no explanation of where their files went.
--
-- Keeping the row means the shell state is a real state: organization present,
-- zero workspaces, `purged_at` set. The dashboard can say what happened and
-- when, and a repurchase reuses the same account rather than making a second
-- one beside the corpse of the first.
--
-- NULL means "never purged", which is every row that exists today.
ALTER TABLE organizations ADD COLUMN purged_at INTEGER;

-- Not partial, unlike `purge_after`'s index. That one answers "who is due?" on
-- every hourly tick and wants the smallest possible index. This one is read
-- once, by one person, on the screen that explains what happened to them — so
-- the index exists to keep that lookup honest rather than to serve a sweep.
CREATE INDEX idx_orgs_purged_at ON organizations(purged_at)
  WHERE purged_at IS NOT NULL;
