-- Firebase Authentication (16 PART 30) replaces the first-party password and
-- refresh-token design this schema was built for.
--
-- What moves to Firebase: password storage, OAuth provider linkage, and session
-- issuance. What stays: everything below `users` - organizations, workspaces,
-- agents, keys, files - is untouched, because none of it ever depended on how a
-- human proved who they were. Agent API keys are unaffected entirely.

-- The join key between a Firebase account and an AgentDisk user.
--
-- Nullable with a unique index, rather than `NOT NULL UNIQUE` on the column:
-- SQLite cannot add a UNIQUE column to an existing table at all, and the
-- provisional owners the sandbox bootstrap creates (0003) have no Firebase
-- account until somebody claims the workspace. A unique index permits many
-- NULLs and at most one row per real uid, which is exactly the constraint
-- wanted here.
ALTER TABLE users ADD COLUMN firebase_uid TEXT;
CREATE UNIQUE INDEX idx_users_firebase_uid ON users(firebase_uid);

-- "Log out everywhere" (30.4), without a refresh-token table to revoke rows in.
-- A token whose `iat` predates this is rejected even though it is still
-- cryptographically valid and unexpired. Unix ms; 0 means never revoked, so the
-- comparison on the request path needs no null handling.
ALTER TABLE users ADD COLUMN session_revoked_after INTEGER NOT NULL DEFAULT 0;

-- Firebase's client SDK owns refresh-token issuance, storage and rotation, and
-- this backend never sees one. 0004 created this table; no code path ever read
-- or wrote it.
DROP TABLE refresh_tokens;

-- No code path ever wrote a non-NULL value here either: the only INSERT into
-- `users` is the sandbox bootstrap, which hardcodes NULL. Dropping it now means
-- a column that could hold a credential cannot quietly acquire one later.
ALTER TABLE users DROP COLUMN password_hash;

-- `oauth_github_id` is deliberately left in place, unused and always NULL.
-- SQLite refuses to drop a column carrying a UNIQUE constraint, and the only
-- alternative - rebuilding `users` - means dropping a table that three live
-- foreign keys point at, with foreign key enforcement on. That is not a trade
-- worth making for a nullable column no code reads.
