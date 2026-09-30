-- Public share links — 05 PART 12.4, designed 20 Sept 2026.
--
-- Two departures from the rest of this schema, both deliberate and both
-- explained in the design spec:
--
--  1. ON DELETE CASCADE, the first in these migrations. Every other cascade
--     here is hand-written because `folders.parent_folder_id` is self-
--     referencing and `files` is referenced from several places, so ordering
--     genuinely matters. `share_links` is a leaf — nothing references it — so
--     the database can do the work, and "must remember to delete this in
--     workspace-cascade.ts and purge.ts" becomes "cannot forget".
--
--  2. `token` is stored in cleartext, where api_keys.key_hash and
--     workspaces.claim_token_hash are hash-only. A share token grants read
--     access to bytes the owner has already chosen to publish — not "own this
--     workspace". It is revocable and dies within 7 days, and a link you
--     cannot copy twice is not a share feature. The consequence, stated
--     plainly: a dump of this table contains live share URLs.
--
-- There is no `revoked_at`. Revoking deletes the row, so a revoked token and a
-- token that never existed are the same absence, and no missed check can serve
-- bytes from a row that should be dead.

CREATE TABLE share_links (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('file','folder')),
  file_id       TEXT REFERENCES files(id) ON DELETE CASCADE,
  folder_path   TEXT,
  token         TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  CHECK ((kind = 'file'   AND file_id IS NOT NULL AND folder_path IS NULL)
      OR (kind = 'folder' AND folder_path IS NOT NULL AND file_id IS NULL))
);

CREATE UNIQUE INDEX idx_share_links_token ON share_links(token_hash);
CREATE INDEX idx_share_links_workspace ON share_links(workspace_id, expires_at);
CREATE INDEX idx_share_links_file ON share_links(file_id);

-- The entitlement column. NULL means "defer to the lib/plans.ts floor" and -1
-- means unlimited, matching migration 0012's convention for every other limit.
ALTER TABLE plans ADD COLUMN share_links INTEGER;
