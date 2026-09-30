-- Bootstrap provisioning support for POST /v1/workspaces (05 PART 13).
--
-- Two columns PART 11.1 does not have, added because PART 13 specifies a
-- `POST /v1/workspaces/:id/claim` endpoint - and a claim endpoint only makes
-- sense if an *unclaimed* state exists for it to act on. The schema had no way
-- to express one.
--
-- Additive and backward-compatible: both columns have defaults, so the running
-- Worker keeps working against this schema before the new code ships.

-- Null until a real, verified user claims the sandbox workspace. An unclaimed
-- workspace is what a self-provisioning agent gets; the reconciliation sweep
-- uses this to expire ones nobody ever claimed.
ALTER TABLE workspaces ADD COLUMN claimed_at INTEGER;

-- The bootstrap flow needs an owner row before any human exists, because
-- organizations.owner_user_id and api_keys.created_by_user_id are both NOT NULL
-- references to users(id). This marks that placeholder.
--
-- A null password_hash cannot carry this meaning on its own: an OAuth user has
-- one of those too, and MVP-1 adds GitHub OAuth. A provisional user must never
-- be able to authenticate by any route, so it gets its own flag.
ALTER TABLE users ADD COLUMN is_provisional INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_workspaces_unclaimed ON workspaces(claimed_at) WHERE claimed_at IS NULL;
