-- staff_actions - the fleet-wide record of what staff did.
--
-- `audit_events.workspace_id` is NOT NULL and carries a real foreign key to
-- `workspaces(id)`. That is correct for everything it was built for: every
-- customer-facing action happens inside exactly one workspace, and a log row
-- that could not name one would be a log row nobody could find.
--
-- Staff actions are not all like that. Looking a user up by email, disabling an
-- account, sending a password reset, creating or disabling a staff account -
-- none of these name a workspace, and an account deletion may leave no
-- surviving workspace to name. There were three ways out and two of them are
-- worse:
--
--   * Drop the record when there is no workspace. The unrecorded actions would
--     then be precisely the cross-tenant ones - the class the staff audit trail
--     exists for.
--   * Attach it to some arbitrary workspace. That is a false record, and a
--     false record in an accountability log is worse than a missing one,
--     because somebody will later read it and believe it.
--   * Make audit_events.workspace_id nullable. In SQLite that is a full table
--     rebuild on a live table, to weaken a constraint that is right for every
--     other writer.
--
-- So: a second table, whose nullable workspace_id is a statement about this
-- table's subject rather than a relaxation of the other's. Where a staff action
-- *does* target a live workspace, both rows are written - this one so the fleet
-- log is complete, and the audit_events one so the workspace's own owner can
-- see that staff acted on their data without having to be told.
--
-- Append-only by convention and by absence: nothing in the codebase issues an
-- UPDATE or a DELETE against it. There is deliberately no retention job. The
-- rows are small, and "how long do we keep the record of staff reaching across
-- a tenant boundary" is not a question a cron should answer on its own.

CREATE TABLE staff_actions (
  id TEXT PRIMARY KEY,

  -- No foreign key to staff_users, on purpose. Staff accounts are disabled and
  -- never deleted precisely so the actor stays resolvable, but a log that a
  -- future schema change could make unwritable is not a log. The email and role
  -- below are denormalised for the same reason: they record who the actor was
  -- *at the time*, which a join to the current row would quietly overwrite.
  actor_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  -- 'support' | 'admin' | 'super_admin' | 'system'. The last one is not a staff
  -- role and cannot log in - it is how scheduled work identifies itself, so
  -- that an expiry sweep is not recorded as a person.
  actor_role TEXT NOT NULL,

  -- The dotted vocabulary from doc 32 PART 9. Several screens filter on the
  -- prefix, so 'plan.edit' and 'plan.push_to_stripe' both answering a
  -- 'plan.%' LIKE is load-bearing, not cosmetic.
  action TEXT NOT NULL,

  -- Nullable, and the reason this table exists.
  workspace_id TEXT REFERENCES workspaces(id),

  -- What was acted on: 'user', 'workspace', 'plan', 'staff', 'key', 'agent'.
  target_type TEXT,
  target_id TEXT,

  -- Mandatory at the API surface for destructive actions; nullable here because
  -- reads legitimately have none, and a column that forced ''  would make
  -- "no reason given" and "reason was empty" indistinguishable.
  reason TEXT,

  result TEXT NOT NULL,
  source_ip TEXT,
  request_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

-- The audit screen's default view: newest first, optionally narrowed by actor.
CREATE INDEX idx_staff_actions_time ON staff_actions(created_at DESC);
CREATE INDEX idx_staff_actions_actor ON staff_actions(actor_id, created_at DESC);
-- Serves both the action filter and the 'plan.%' prefix match behind Sync
-- History, which is why action leads the index rather than trailing it.
CREATE INDEX idx_staff_actions_action ON staff_actions(action, created_at DESC);
