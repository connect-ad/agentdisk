-- Real numbers in the catalogue, matching the lib/plans.ts floor.
--
-- The catalogue is what the request path reads; the hardcoded table is the
-- per-field floor beneath it. They agreed while every field was UNLIMITED and
-- would silently disagree the moment one stopped being - the catalogue would
-- keep selling unlimited egress that the floor no longer described.
--
-- Two reversals are encoded here.
--
-- `egress_bytes_period` is ten times storage rather than unlimited. Decision D2
-- of the billing design made it unlimited because "R2 egress costs $0, so it is
-- free to promise". Verified against live pricing, that is true of egress and
-- false of the thing that actually costs: Class A writes at $4.50/million and
-- Class B reads at $0.36/million. The cap is not a cost control - it is a shape
-- customers read, and a headline against a competitor capping at five times.
--
-- `file_count` stops being unlimited, and this is the one that was costing
-- money. `max_file_bytes` bounds a single request; nothing bounded the NUMBER
-- of them, so a million 10 KB files cost $4.50 to ingest and paid nothing on
-- the free plan. Storage was never the exposure.
--
-- `requests_period` stays unlimited: metering costs a D1 write per request, the
-- counter is being added so the decision can later be made from data, and
-- paying that on every call before there is a paying customer is the wrong
-- trade.
--
-- `max_file_bytes` on team drops to 4.9 GB. R2's single-part ceiling is 4.995
-- GiB and multipart upload is not built, so 5 GB would be a published limit no
-- upload path can reach.

UPDATE plans SET
  storage_bytes        = 1073741824,      -- 1 GB
  file_count           = 10000,
  egress_bytes_period  = 10737418240,     -- 10 GB
  requests_period      = -1,              -- unlimited; see migration 0012
  max_file_bytes       = 104857600,       -- 100 MB
  agents = 1, api_keys = 2, members = 1, workspaces = 1, share_links = 0
WHERE id = 'free';

UPDATE plans SET
  storage_bytes        = 5368709120,      -- 5 GB
  file_count           = 100000,
  egress_bytes_period  = 53687091200,     -- 50 GB
  requests_period      = -1,
  max_file_bytes       = 524288000,       -- 500 MB
  agents = 5, api_keys = 6, members = 2, workspaces = 3, share_links = 10
WHERE id = 'basic';

UPDATE plans SET
  storage_bytes        = 53687091200,     -- 50 GB
  file_count           = 1000000,
  egress_bytes_period  = 536870912000,    -- 500 GB
  requests_period      = -1,
  max_file_bytes       = 1073741824,      -- 1 GB
  agents = 10, api_keys = 20, members = 5, workspaces = 10, share_links = 100
WHERE id = 'pro';

UPDATE plans SET
  storage_bytes        = 536870912000,    -- 500 GB
  file_count           = 10000000,
  egress_bytes_period  = 5368709120000,   -- 5000 GB, ten times storage
  requests_period      = -1,
  max_file_bytes       = 5261334118,      -- 4.9 GB, under R2's single-part cap
  agents = 50, api_keys = 100, members = 25, workspaces = 50, share_links = -1
WHERE id = 'team';
