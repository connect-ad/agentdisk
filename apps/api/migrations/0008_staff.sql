-- Staff authentication — 14 PART 27.2.
--
-- Every guarantee in 06 PART 16.1 rests on one invariant: a request's
-- `workspace_id` comes from the caller's identity and a handler is structurally
-- unable to query outside it. A staff console exists to violate that on
-- purpose, because a support engineer needs to look at any customer's
-- workspace.
--
-- So staff are not a customer role with extra permissions. They are a separate
-- table, a separate session mechanism, and a separate code path — which is what
-- lets the customer-facing model keep its "never" as an actual never, rather
-- than a "never, except for staff" scattered through the same handlers.
--
-- Deliberately not Firebase, unlike customer auth (16 PART 30). Staff is a
-- small, manually provisioned team where self-service signup and social login
-- buy nothing and would have to be actively disabled; and independence means a
-- Firebase outage never stops AgentDisk's own team logging in to investigate
-- exactly the kind of incident staff access exists for.

CREATE TABLE staff_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  -- PBKDF2-SHA256 with a per-password salt. 06 PART 16.5 specifies Argon2id and
  -- names bcrypt as the documented fallback; neither runs in Workers without a
  -- WASM dependency, and the CPU-per-request cap is the reason that section
  -- required measuring rather than assuming. PBKDF2 is what Web Crypto provides
  -- natively, and it is what the platform can actually do at a defensible
  -- iteration count. The record of this decision is the comment you are
  -- reading, not a silent substitution.
  password_hash TEXT NOT NULL,
  -- Base32, encrypted at rest with DATABASE_ENCRYPTION_KEY, decrypted only in
  -- memory at verification. A TOTP secret in plaintext makes the second factor
  -- worth exactly as much as the database it sits in.
  totp_secret TEXT NOT NULL,
  -- 'support' | 'admin' | 'super_admin'
  role TEXT NOT NULL,
  disabled_at INTEGER,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Intentionally simpler than any customer session: short-lived, no rotation
-- family, no "remember me". A stolen staff session is a far higher-value
-- compromise than a customer one, and the answer to that is a shorter window,
-- not more session machinery to get wrong.
CREATE TABLE staff_sessions (
  id TEXT PRIMARY KEY,
  staff_user_id TEXT NOT NULL REFERENCES staff_users(id),
  -- SHA-256. Same discipline as api_keys.key_hash: a database disclosure yields
  -- hashes, not usable sessions.
  token_hash TEXT NOT NULL UNIQUE,
  -- Four hours, not thirty days.
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_staff_sessions_user ON staff_sessions(staff_user_id);
CREATE INDEX idx_staff_sessions_expiry ON staff_sessions(expires_at);

-- Staff actions land in the same audit table as everything else, with
-- actor_type 'staff'. One trail rather than two: an investigation into what
-- happened to a workspace should not have to know in advance whether the answer
-- involves a customer or a member of our own team.
