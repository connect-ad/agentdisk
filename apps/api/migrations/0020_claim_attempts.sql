-- Who touched which claim link, and what happened.
--
-- Migration 0019's sibling in purpose: 0019 made a claimed link answer 404,
-- identical to a token that never existed, because this route takes no
-- credential and a distinguishable answer tells a guesser which guesses named
-- a real workspace. That removed the client's explanation. This is where the
-- explanation goes instead - support can say what happened to a link without
-- the answer being free to everyone.
--
-- `recordClaim` cannot serve it. That writes to `audit_events`, only on
-- success, requires both a workspace and a user, and hardcodes `ip` to NULL -
-- so it covers none of the previews, none of the refusals, and none of the
-- unknown tokens. Worse, `audit_events` is deleted along with the workspace,
-- so the trail would vanish exactly when an investigation wanted it.
--
-- No foreign keys, deliberately, and for the same reason `pending_deletions`
-- has none: the workspace a row names may already be gone, and the row is
-- worth most precisely then. `workspace_id` is denormalised TEXT.
--
-- Only the HASH is stored. Same rule as `workspaces.claim_token_hash`: a
-- support engineer can confirm which link was used and can never use it.
--
-- These rows hold IP addresses of unauthenticated visitors, which is personal
-- data. They are trimmed after 90 days by the same sweep that erases bytes -
-- long enough for the investigation this exists for, short enough that a log
-- of strangers' addresses does not become a liability nobody decided to keep.
CREATE TABLE claim_attempts (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL,
  workspace_id  TEXT,
  outcome       TEXT NOT NULL,
  user_id       TEXT,
  ip            TEXT,
  user_agent    TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_claim_attempts_token ON claim_attempts(token_hash, created_at DESC);
CREATE INDEX idx_claim_attempts_workspace ON claim_attempts(workspace_id, created_at DESC);
-- The retention trim scans by age.
CREATE INDEX idx_claim_attempts_created ON claim_attempts(created_at);
