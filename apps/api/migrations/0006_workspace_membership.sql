-- Membership becomes per-workspace, and "member" becomes "reader".
--
-- The billing account (an `organizations` row) still owns many workspaces and
-- still pays for all of them with one card - that part is unchanged. What
-- changes is who can see what inside it: an owner can invite somebody to one
-- workspace without handing them every other workspace on the same bill, which
-- is the whole point of keeping two clients' work apart.
--
-- This is a table rebuild rather than an ALTER, and it has to be. 0002 declared
-- `UNIQUE(org_id, user_id)` at the table level, which now says the wrong thing:
-- one person legitimately holds several rows in one org - one per workspace
-- they were invited to, plus possibly an org-wide row if they own it. SQLite
-- cannot drop a table-level constraint in place, and adding partial unique
-- indexes alongside it does not relax it. Nothing has a foreign key pointing at
-- `memberships`, so rebuilding it is safe in a way that rebuilding `users`
-- would not be.

CREATE TABLE memberships_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  -- NULL means "every workspace in this organization", which is what an owner
  -- holds. A row naming a workspace grants exactly that one.
  --
  -- Nullable rather than a second table: the question "may this person act in
  -- this workspace" then has one place to look instead of two that can
  -- disagree, and the org-wide case stays a single row rather than one per
  -- workspace that something has to remember to create.
  workspace_id TEXT REFERENCES workspaces(id),
  -- 'owner' | 'admin' | 'reader'. 'member' was the middle role and could do
  -- everything an admin could except manage people, which at the file level is
  -- no difference at all - so the role people actually wanted, somebody who can
  -- see the work without changing it, did not exist.
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO memberships_new (id, org_id, user_id, workspace_id, role, created_at)
  SELECT id, org_id, user_id, NULL,
         CASE role WHEN 'member' THEN 'reader' ELSE role END,
         created_at
    FROM memberships;

DROP TABLE memberships;

ALTER TABLE memberships_new RENAME TO memberships;

-- Two partial indexes rather than one over all three columns: SQLite treats
-- NULLs as distinct in a unique index, so a single index would happily allow
-- two org-wide rows for the same person.
CREATE UNIQUE INDEX idx_memberships_org_wide
  ON memberships(org_id, user_id) WHERE workspace_id IS NULL;

CREATE UNIQUE INDEX idx_memberships_workspace
  ON memberships(workspace_id, user_id) WHERE workspace_id IS NOT NULL;

-- The lookup the authorization chain runs on every human request.
CREATE INDEX idx_memberships_user_workspace ON memberships(user_id, workspace_id);
