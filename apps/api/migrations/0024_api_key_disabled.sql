-- Keys are disabled and enabled, not revoked.
--
-- Revoke was a one-way kill switch: the only way back was minting a new key
-- and updating whatever held the old one. The owner's call (22 Sept 2026) is
-- a reversible switch instead - and enabling **rotates the secret**, so a key
-- disabled because it leaked cannot be brought back to life unchanged. The
-- old token stops working at the moment of disable and never works again;
-- what comes back is a new secret under the same row, which keeps the key's
-- name, scope, agent and audit history intact.
--
-- disabled_at is the switch. NULL means enabled, a timestamp means off, and
-- authentication refuses the key either way it is off.
ALTER TABLE api_keys ADD COLUMN disabled_at INTEGER;

-- Every key revoked so far becomes disabled, so no row is left in a state the
-- dashboard can no longer express or act on. They are dead credentials either
-- way: their `key_hash` is unchanged here, and enabling one rotates it, so
-- nothing that was revoked ever authenticates again with its old token.
--
-- `revoked_at` itself stays. The admin console keeps a permanent revoke as an
-- operator kill switch (admin/access.ts), which is a different act from a
-- customer switching their own key off, and a row it writes must still be
-- distinguishable from one the customer can simply turn back on.
UPDATE api_keys SET disabled_at = revoked_at WHERE revoked_at IS NOT NULL;
UPDATE api_keys SET revoked_at = NULL WHERE revoked_at IS NOT NULL;
