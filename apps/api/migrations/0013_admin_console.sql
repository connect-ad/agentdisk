-- The admin console's own schema — 32 PART 2, 7 and 9.
--
-- Five additions, and every one of them exists because a admin action needs a
-- *first-party* fact to act on. The panel reaches across tenant boundaries, so
-- anywhere it depends on a third party's side effect having succeeded is a
-- place where "this account is gone" and "the call to disable it failed" look
-- identical from here.

-- ── users: deletion and disablement, as our own state ──────────────────────
--
-- Both are soft. Neither removes a row.
--
-- `deleted_at` is set by DELETE /v1/admin/users/:id and cleared by the restore
-- endpoint inside a 30-day window; the cascade and the PII scrub happen only
-- from the purge job, afterwards. `disabled_at` is the reversible for-cause
-- block, with no window and no purge.
--
-- The reason these are columns here rather than a Firebase lookup: disabling a
-- Firebase identity does not invalidate an ID token that has already been
-- issued, which stays valid for up to its remaining hour. If deletion depended
-- on the Firebase call alone, a failed `disableUser` would leave a live
-- identity refreshing tokens indefinitely while this database said deleted.
-- The auth chain therefore checks these two columns directly, before and
-- independently of anything Firebase says — see auth/authenticate.ts.
ALTER TABLE users ADD COLUMN deleted_at INTEGER;
ALTER TABLE users ADD COLUMN disabled_at INTEGER;

-- Partial, because the overwhelming majority of rows are NULL on both and an
-- index over those would be dead weight on every write. These serve the admin
-- console's "pending deletion" view and the purge job's sweep, which are the
-- only two readers that ask "which users are in this state".
CREATE INDEX idx_users_deleted ON users(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_users_disabled ON users(disabled_at) WHERE disabled_at IS NOT NULL;

-- ── workspaces: the same 30-day window ─────────────────────────────────────
--
-- `workspaces.status` already carries 'deleted', but a status alone cannot say
-- *when*, and the window is the whole point: a admin member deleting somebody
-- else's workspace is exactly where the absence of a grace period hurts most.
-- status stays the thing every read path checks; this column is what the purge
-- job and the restore action need on top of it.
ALTER TABLE workspaces ADD COLUMN deleted_at INTEGER;
CREATE INDEX idx_workspaces_deleted ON workspaces(deleted_at) WHERE deleted_at IS NOT NULL;

-- ── admin_users: pending enrolment is a real state ─────────────────────────
--
-- TOTP is mandatory for every admin account, so a row can legitimately be
-- *invited but not yet enrolled* — it has a generated secret nobody has
-- scanned — but never *enrolled without TOTP*. Without this column those two
-- are indistinguishable, and an invited account that never completed setup
-- would be able to authenticate with a secret that was printed once into a
-- response and then lost.
--
-- Backfilled to created_at rather than left NULL. Every admin account that
-- exists today was provisioned by scripts/provision-admin.mjs, which prints the
-- enrolment URI at creation — those people are enrolled. Defaulting them to
-- NULL would read as "pending" and lock out the only accounts that can
-- currently log in, including the one that would have to fix it.
ALTER TABLE admin_users ADD COLUMN totp_confirmed_at INTEGER;
UPDATE admin_users SET totp_confirmed_at = created_at WHERE totp_confirmed_at IS NULL;

-- ── plans: which side last wrote, and when ─────────────────────────────────
--
-- Scalars, deliberately — there is no plan_sync_events table and should not be
-- one. The Sync History screen is a filter over admin_actions for `plan.%`,
-- which already records who, when, which fields and the result. These two
-- columns answer a different and smaller question that the list view needs per
-- row without a join: is this row in sync, and which way did it last move.
--
-- 'inbound'  — Stripe -> D1 (a webhook, or the admin sync)
-- 'outbound' — D1 -> Stripe (a admin plan edit pushed through)
ALTER TABLE plans ADD COLUMN last_synced_at INTEGER;
ALTER TABLE plans ADD COLUMN last_synced_direction TEXT;
