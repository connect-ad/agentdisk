-- Name the plans the way Stripe will name them.
--
-- Migration 0012 seeded `plans.name` as "Free", "Basic", "Pro", "Team", which
-- reads fine in isolation. `infra/stripe-catalogue/catalogue.tf` creates the
-- Stripe products as "AgentDisk Free", "AgentDisk Basic" and so on - because
-- the Stripe account is shared with other projects, and a product called "Pro"
-- sitting beside "Amardrive Pro" is ambiguous to whoever opens the dashboard.
--
-- So the two disagreed, and the console showed the D1 name. The first catalogue
-- sync would have quietly corrected it - `syncProductToPlan` writes
-- `product.name` straight into this column - which is the worse way to find
-- out, because a name changing on its own looks like something went wrong.
--
-- Only `name` moves. `id` is the join key used by `organizations.plan`,
-- `workspaces.plan_override` and every entitlement lookup; renaming that would
-- orphan every account on a paid plan. The ids stay `free`, `basic`, `pro`,
-- `team`.
--
-- Guarded on the old value rather than applied blindly: if a name has already
-- been changed - by the sync, or by an operator in the console - that edit is
-- the more recent intent and this migration must not walk over it.

UPDATE plans SET name = 'AgentDisk Free', updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE id = 'free' AND name = 'Free';

UPDATE plans SET name = 'AgentDisk Basic', updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE id = 'basic' AND name = 'Basic';

UPDATE plans SET name = 'AgentDisk Pro', updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE id = 'pro' AND name = 'Pro';

UPDATE plans SET name = 'AgentDisk Team', updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE id = 'team' AND name = 'Team';
