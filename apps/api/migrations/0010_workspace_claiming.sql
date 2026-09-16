-- Workspace claiming - the bearer link that turns an unclaimed sandbox into
-- somebody's workspace.
--
-- A claim link is a bearer secret with the power "become the owner of this
-- workspace, and everything in it". That is at least as strong as an API key,
-- and it leaks the same ways a password-reset link does: a shell history, a
-- CI log, an agent that helpfully prints its own provisioning response. So it
-- is stored exactly the way api_keys.key_hash is - only the SHA-256 reaches
-- this table, and the raw token is returned once at provisioning time and is
-- unrecoverable afterwards.
--
-- The expiry is separate from, and longer than, the unclaimed-workspace
-- deletion clock in jobs/sandbox-expiry.ts. They answer different questions:
-- this one is "is this link still good?", that one is "should this abandoned
-- workspace still exist?". Tying them together would mean extending a link's
-- life silently extended the data's, which is not a decision a claim link
-- should be able to make.

ALTER TABLE workspaces ADD COLUMN claim_token_hash TEXT;
ALTER TABLE workspaces ADD COLUMN claim_token_expires_at INTEGER;

-- Partial, so the many rows with no claim token do not contend for one NULL
-- slot - SQLite treats NULLs as distinct in a UNIQUE index, but the partial
-- index also keeps it small: only live sandboxes are in it.
--
-- Unique because the hash is how a claim request finds its workspace. Two rows
-- sharing one hash would make that lookup ambiguous, which for a credential
-- lookup is the same class of bug as two API keys hashing alike.
CREATE UNIQUE INDEX idx_workspaces_claim_token ON workspaces(claim_token_hash)
  WHERE claim_token_hash IS NOT NULL;

-- The sweep's query: unclaimed workspaces old enough to expire. idx_workspaces_unclaimed
-- (0003) already covers `claimed_at IS NULL`, but not the created_at ordering
-- the sweep needs, so it would fall back to a scan of every unclaimed row.
CREATE INDEX idx_workspaces_unclaimed_age ON workspaces(created_at)
  WHERE claimed_at IS NULL;
