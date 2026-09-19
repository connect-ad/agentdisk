-- Refresh tokens: backs human session security (06 PART 15.1) and the Active
-- Sessions UI (03 §8.23). Specified in 05 PART 11.1 / 11.1a.
--
-- A FORWARD migration rather than an edit to 0002_core_schema.sql, which is
-- where this table's DDL now sits in the spec. 0002 has already been applied to
-- dev's D1; editing an applied migration means the schema a fresh database gets
-- and the schema a live one has are different, and nothing detects the drift
-- until something fails in production.
--
-- Nothing writes to this table yet. It lands with the schema rather than with
-- the session code so that the code has somewhere to write when it arrives, and
-- so that this additive change is deployed on its own rather than inside the
-- change that starts issuing sessions.

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,               -- 'rft_' + ULID
  user_id TEXT NOT NULL REFERENCES users(id),
  -- Shared across every rotation of one login session. Revoking by family_id
  -- kills that whole lineage, which is what reuse-detection needs (16.6): a
  -- token presented after it has already been rotated means someone has a copy,
  -- so every descendant of that login is invalidated, not just the one row.
  family_id TEXT NOT NULL,
  -- SHA-256(token), hex. The raw token is never stored, mirroring
  -- api_keys.key_hash - a database disclosure must not yield usable sessions.
  token_hash TEXT NOT NULL UNIQUE,
  device_label TEXT,                 -- parsed User-Agent, for the Active Sessions list
  ip_created TEXT,
  last_used_at INTEGER,
  expires_at INTEGER NOT NULL,       -- 30 days from issuance (15.1)
  -- Set on logout, on an explicit per-session "Sign out", or across a whole
  -- family on reuse-detected rotation.
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens(family_id);
