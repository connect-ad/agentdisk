-- Storage and file quota move from the workspace to the billing account.
--
-- The subscription is sold to an organization: one card, one plan, many
-- workspaces. Until now `assertWithinQuota` compared a single workspace's
-- counters against that account-level plan, so an account on Pro holding five
-- workspaces held five times the Pro storage allowance — and the way to get
-- more room was to press "New workspace", which is free. Membership being
-- per-workspace made this easy to miss: the two are scoped differently on
-- purpose, and only the *quota* was on the wrong side of the line.
--
-- `plan_override` keeps its meaning and is untouched. It answers "which
-- limits", which is still a per-workspace question a staff operator may need
-- to answer; these columns answer "how much is used", which is not.
--
-- Denormalized, for the same reason the workspace counters are: summing the
-- account's files on every upload would put a table scan on the hot path of
-- every write. `reconcileCounters` (jobs/purge.ts) is what makes them
-- eventually true, and it now reconciles both levels.
--
-- The backfill sums `files` rather than the workspace counters sitting beside
-- them. Those counters are themselves denormalized and are known to drift —
-- drift correction is why the reconciler exists — so seeding a new counter
-- from a possibly-wrong one would copy the drift upward and leave the
-- reconciler nothing to notice. Only `active` rows count, matching the
-- reconciler exactly: a row still marked `deleted` released its quota when the
-- delete was accepted and is only waiting on the reaper.

ALTER TABLE organizations ADD COLUMN storage_bytes_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE organizations ADD COLUMN file_count INTEGER NOT NULL DEFAULT 0;

UPDATE organizations
   SET storage_bytes_used = (
         SELECT COALESCE(SUM(f.size_bytes), 0)
           FROM files f
           JOIN workspaces w ON w.id = f.workspace_id
          WHERE w.org_id = organizations.id
            AND f.status = 'active'
       ),
       file_count = (
         SELECT COUNT(*)
           FROM files f
           JOIN workspaces w ON w.id = f.workspace_id
          WHERE w.org_id = organizations.id
            AND f.status = 'active'
       );

