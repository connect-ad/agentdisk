-- Deleting an agent deletes the row.
--
-- Until now it set status = 'deleted' and kept the row, and the table's
-- UNIQUE(workspace_id, name) went on counting it: an agent nobody could see
-- still held its name, so re-creating "agent01" after deleting it answered
-- "already exists". The owner's rule (22 Sept 2026) is that delete means
-- gone - a workspace goes with everything in it, and only the files are
-- deferred - so the repository now issues a real DELETE, and this clears the
-- rows the old behaviour stranded.
--
-- Keys first, although routes/agents.ts already removed every key at delete
-- time: api_keys.agent_id is the one foreign key into this table, and a
-- migration that can fail on data it did not expect is worse than one
-- statement it never needs.
DELETE FROM api_keys WHERE agent_id IN (SELECT id FROM agents WHERE status = 'deleted');
DELETE FROM agents WHERE status = 'deleted';
