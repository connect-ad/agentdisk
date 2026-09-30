-- An optional password on a share link, 25 Sept 2026.
--
-- Hash only, unlike `token` beside it. The token is cleartext so the owner can
-- copy the link again; a password is something the owner already knows and
-- tells the recipient separately, so there is nothing to show twice and no
-- reason to keep it. NULL means the link needs no password.
--
-- The format is `pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>` — see
-- lib/shares.ts. Carrying the iteration count in the value is what lets it be
-- raised later without invalidating the links already made.

ALTER TABLE share_links ADD COLUMN password_hash TEXT;
