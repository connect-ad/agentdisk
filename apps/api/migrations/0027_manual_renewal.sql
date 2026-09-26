-- Manual renewal: the period we own, and the messages we must not repeat.
--
-- AgentDisk does not auto-renew (owner's decision, 23 September 2026). Each
-- purchase buys one month and then stops. That choice moves three things from
-- Stripe into this database.
--
-- **The period.** A Stripe Subscription carries its own `current_period_end`
-- and renews against it. A one-off payment carries nothing — Stripe's job ends
-- when the charge clears. So the period end lives here, is written by
-- `checkout.session.completed`, and is the only thing that decides whether an
-- account may still write. NULL means "never bought anything", which is every
-- free account and every row predating this migration; it is not "expired".
--
-- **The deletion clock.** Seven days after expiry the account's data is
-- scheduled for removal, and `purge_after` is that stamp. Deliberately the same
-- name and the same partial-index shape as `users.purge_after` from
-- `0019_account_purge.sql`, because it is the same idea reaching a different
-- table and two spellings of one concept is how they drift apart.
--
-- NULL means "not queued", and a renewal sets it back to NULL. That reversal is
-- the single most important behaviour this feature has: somebody who pays on day
-- ten must not be deleted by a sweep that stamped them on day seven.
--
-- **The dunning log.** Stripe used to send these. Now we do, from an hourly
-- cron, which means without a guard every reminder goes out 168 times a week.
-- `notifications_sent` is that guard, and the UNIQUE index below *is* the
-- mechanism — not application logic that could be forgotten at a new call site.
-- The key includes `period_end` so the same account renewing next month gets the
-- same three messages again, which is correct: they are about a period, not
-- about an account.

ALTER TABLE organizations ADD COLUMN current_period_end INTEGER;
ALTER TABLE organizations ADD COLUMN purge_after INTEGER;

-- Partial, because the interesting rows are the minority in both cases: the
-- sweep asks "who is due?" and a full index over mostly-NULL would be read on
-- every write to organizations for nothing.
CREATE INDEX idx_orgs_period_end ON organizations(current_period_end)
  WHERE current_period_end IS NOT NULL;

CREATE INDEX idx_orgs_purge_after ON organizations(purge_after)
  WHERE purge_after IS NOT NULL;

CREATE TABLE notifications_sent (
  id         TEXT    PRIMARY KEY,
  org_id     TEXT    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- renewal_reminder | expired | deletion_scheduled
  --
  -- Not a CHECK constraint: adding a fourth message would then be a migration
  -- rather than a template, and SQLite cannot alter a CHECK in place. The set
  -- of kinds lives in `jobs/billing-renewal.ts`, next to the code that sends
  -- them.
  kind       TEXT    NOT NULL,
  -- Which period this message concerns, copied from `current_period_end` at
  -- send time. Part of the key, so a renewed account is messaged again.
  period_end INTEGER NOT NULL,
  sent_at    INTEGER NOT NULL
);

-- The guard itself. A second insert for the same (org, kind, period) fails, and
-- that failure is how the cron knows it has already sent this one.
CREATE UNIQUE INDEX idx_notifications_once
  ON notifications_sent(org_id, kind, period_end);
