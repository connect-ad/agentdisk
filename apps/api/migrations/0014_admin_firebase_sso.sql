-- Admin sign in with Firebase, like everybody else. The database decides who
-- is an admin.
--
-- ── This reverses 0008, deliberately ───────────────────────────────────────
-- 0008 made admin auth independent of Firebase on the reasoning that "a
-- Firebase outage never stops AgentDisk's own team logging in to investigate
-- exactly the kind of incident admin access exists for". That reasoning was
-- sound and it has been overruled by the owner: one sign-in for every surface,
-- with the role held here.
--
-- The property being traded away, stated so nobody has to reconstruct it: a
-- admin credential and a customer credential are no longer structurally
-- incapable of reaching each other's routes. One Firebase token now reaches
-- both, and the ONLY thing separating them is the `admin_users` lookup below.
-- That lookup is therefore load-bearing in a way the old session table was not,
-- which is why the role lives here and never in a Firebase custom claim: a
-- claim is minted once and can go stale in a token already issued, whereas a
-- row is read fresh on every request and a disable takes effect immediately.
--
-- ── What is gone ───────────────────────────────────────────────────────────
-- password_hash, totp_secret and totp_confirmed_at, because there is no
-- password and no second factor of our own any more - Firebase owns both.
-- admin_sessions, because a Firebase ID token IS the session.
--
-- SQLite cannot drop a NOT NULL column in place, so this is a table rebuild -
-- the same shape 0006 used for memberships. The table holds a handful of rows,
-- so the rebuild is cheap; what matters is that it is done in one transaction
-- with the foreign keys deferred, which wrangler's migration runner provides.

-- ── This goes FIRST, and the order is the whole bug ────────────────────────
-- `admin_sessions` carries a foreign key to `admin_users(id)`. Dropping the
-- parent while a child table still references it violates that constraint, and
-- D1 enforces it - so rebuilding admin_users before this line fails the whole
-- migration. The repository already has this rule written down: clear inbound
-- foreign keys before deleting a subtree.
--
-- It cost a failed deploy to rediscover, because the test runtime applies
-- migrations without enforcing foreign keys and the suite was perfectly green.
--
-- The table itself has nothing left to hold: a Firebase ID token is the
-- session. Revocation is `disabled_at` on the row below, checked per request,
-- which takes effect strictly faster than revoking a four-hour session did.
DROP TABLE IF EXISTS admin_sessions;

CREATE TABLE admin_users_new (
  id TEXT PRIMARY KEY,

  -- The join key to a Firebase identity, and the audit identity.
  --
  -- Matched case-insensitively at the API by lowercasing both sides before the
  -- comparison; stored lowercase here. An address that differs only in case is
  -- the same person to Google and would otherwise be a different admin member
  -- to us, which is a silent authorisation gap rather than a cosmetic one.
  email TEXT NOT NULL UNIQUE,

  -- 'support' | 'admin' | 'super_admin'. Read fresh on every request.
  role TEXT NOT NULL,

  disabled_at INTEGER,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL,

  -- Who added them. Nullable because the first row has nobody to name, and
  -- deliberately not a foreign key for the same reason admin_actions has none:
  -- a log of who granted authority must not become unwritable because of a
  -- later schema change.
  invited_by TEXT
);

-- Carry across whatever exists. Any account provisioned under the old scheme
-- keeps its id, email and role - so `admin_actions` rows written before this
-- migration still resolve to the same actor - and simply stops having a
-- password nobody will ever use again.
INSERT INTO admin_users_new (id, email, role, disabled_at, last_login_at, created_at, invited_by)
SELECT id, LOWER(email), role, disabled_at, last_login_at, created_at, NULL FROM admin_users;

DROP TABLE admin_users;
ALTER TABLE admin_users_new RENAME TO admin_users;

-- The first administrator.
--
-- Seeded here rather than by a script or a pipeline, because under this scheme
-- an admin IS an email address in this table - there is no credential to mint,
-- so there is nothing for a provisioning step to do. `INSERT OR IGNORE` so
-- re-running against a database that already has the row is not an error.
INSERT OR IGNORE INTO admin_users (id, email, role, disabled_at, last_login_at, created_at, invited_by)
VALUES (
  'stf_seed_owner',
  'kernelv5@gmail.com',
  'super_admin',
  NULL,
  NULL,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  NULL
);

CREATE INDEX idx_admin_users_role ON admin_users(role);
