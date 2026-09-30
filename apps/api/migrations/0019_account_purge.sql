-- When a deleted account's identity and address are finally released.
--
-- The Firebase identity cannot be deleted in the request, and neither can the
-- email address be released there. `resolveVerifiedUser` refuses a token by
-- reading `users.deleted_at` as a FIRST-PARTY check, before asking Firebase
-- anything, precisely so that deletion does not depend on a third party's side
-- effect having succeeded. That check needs the row.
--
-- And the address has to stay mailable for the whole window: the dunning
-- warnings and the deletion-confirmed message are all sent after the account is
-- marked deleted. An earlier draft of this design released the address on day
-- zero and left those emails with nowhere to go - two halves of one feature
-- breaking each other, each correct on its own.
--
-- So both happen together, at the end: the sweep deletes the Firebase identity
-- and scrubs `users.email` in one step.
--
-- NULL means "not queued": every row that predates this column, and every live
-- account.
ALTER TABLE users ADD COLUMN purge_after INTEGER;

CREATE INDEX idx_users_purge_after ON users(purge_after)
  WHERE purge_after IS NOT NULL;
