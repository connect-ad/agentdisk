-- Deferred file deletion on workspace delete — designed 22 September 2026.
--
-- A workspace delete used to destroy a tenant's whole byte inventory inside one
-- HTTP request: unbounded (one R2 round trip per 1000 objects), silent when it
-- half-finished (the R2 deletes are not in the D1 batch, so a later failure
-- rolled the rows back over objects that were already gone), and with no
-- interval in which anybody could look.
--
-- The credentials and the metadata still die in the request - keys, agents,
-- webhooks, share links, the workspace row itself. Only the bytes wait, and
-- nobody can observe those. What defers is the part with no customer-visible
-- surface.
--
-- ── Why a table rather than a flag on `files` ────────────────────────────────
-- `files.workspace_id` is NOT NULL REFERENCES workspaces(id), so a hard-deleted
-- workspace cannot leave rows behind in that table; making it able to means a
-- full SQLite rebuild of the largest, hottest table in the schema to weaken a
-- constraint that is correct for every other row in it. Moving the rows out
-- gives the stronger property for less work: they are no longer in `files` at
-- all, so no scoped repository, no search, no listing, no quota query and no
-- future query can return one. There is nothing to remember to filter -
-- "cannot forget" beats "must remember", the same reason share_links got a
-- real ON DELETE CASCADE.

CREATE TABLE pending_deletions (
  file_id         TEXT PRIMARY KEY,
  r2_object_key   TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  path            TEXT NOT NULL,
  name            TEXT NOT NULL,

  -- Denormalised, plain TEXT, no foreign keys. Every row these name is gone by
  -- the time this row exists, so a join is impossible rather than merely
  -- undesirable. Same reasoning as admin_actions.actor_email.
  workspace_id    TEXT NOT NULL,
  workspace_name  TEXT NOT NULL,
  org_id          TEXT NOT NULL,
  deleted_by      TEXT NOT NULL,
  source          TEXT NOT NULL,   -- 'workspace_delete' today; room for more

  marked_at       INTEGER NOT NULL,
  -- Stored, never computed from marked_at at read time. Changing the retention
  -- constant later must not retroactively move the due date of files already
  -- queued under the old promise.
  due_at          INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);
CREATE INDEX idx_pending_deletions_due ON pending_deletions(due_at);
CREATE INDEX idx_pending_deletions_workspace ON pending_deletions(workspace_id);

-- Every job on the cron tick writes to console.log and nowhere else, and a
-- Worker cannot read its own logs - so "what did the last run do?" has never
-- been answerable. Shaped generically, with a `job` column rather than a table
-- per job, so the existing five can start writing here later; this migration
-- wires up only the new one.
--
-- finished_at IS NULL is a run that died mid-flight. That is rendered as
-- "interrupted" rather than hidden: a job that stopped reporting is the thing
-- you most want to see.
CREATE TABLE job_runs (
  id              TEXT PRIMARY KEY,
  job             TEXT NOT NULL,
  trigger         TEXT NOT NULL,   -- 'cron' | 'admin'
  actor_id        TEXT,            -- admin id when trigger = 'admin', else NULL
  actor_email     TEXT,
  dry_run         INTEGER NOT NULL,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  examined        INTEGER NOT NULL DEFAULT 0,
  objects_deleted INTEGER NOT NULL DEFAULT 0,
  rows_deleted    INTEGER NOT NULL DEFAULT 0,
  bytes_freed     INTEGER NOT NULL DEFAULT 0,
  failed          INTEGER NOT NULL DEFAULT 0,
  error           TEXT
);
CREATE INDEX idx_job_runs_job_started ON job_runs(job, started_at DESC);
