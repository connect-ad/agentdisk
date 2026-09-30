-- Which address provisioned each sandbox, 28 Sept 2026.
--
-- POST /v1/workspaces no longer requires a Turnstile token. The bot check was
-- the wrong fence for that route: it kept out the unattended agent the route
-- exists for, and it cost a determined abuser cents at a solver service. What
-- bounds abuse instead is a cap on how many *unclaimed* sandboxes one address
-- may hold at once, and that needs the address on the row.
--
-- A count over rows, deliberately, rather than a counter. A claim frees the
-- slot the instant `claimed_at` is set, and the unclaimed sweep frees the
-- rest, so nothing here needs cleaning on a schedule and an honest agent that
-- creates, claims and moves on is never locked out by its own history. The
-- claim handler also nulls the address: once a person owns the workspace it
-- is personal data with no further use.
--
-- NULL for every row that predates this migration and for every workspace a
-- signed-in person creates. Neither is ever counted.

ALTER TABLE workspaces ADD COLUMN creator_ip TEXT;

-- Partial: the cap only ever asks about unclaimed rows that carry an address,
-- so the index holds exactly those and stays tiny however large the table.
CREATE INDEX idx_workspaces_creator_unclaimed
  ON workspaces (creator_ip)
  WHERE claimed_at IS NULL AND creator_ip IS NOT NULL;
