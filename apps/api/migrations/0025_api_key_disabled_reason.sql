-- Which switch turned a key off.
--
-- Disabling an agent now really disables its keys, and enabling the agent
-- rotates them back on (migration 0024 gave keys the switch; this makes the
-- agent's switch drive it). That needs the reason stored rather than derived:
-- once the agent is active again, nothing in the row would otherwise say
-- whether a key is off because the agent was off, or because the customer
-- deliberately turned that one key off. Enabling the agent must restore the
-- first kind and leave the second alone.
--
-- 'key'   - the customer switched this key off.
-- 'agent' - it went off with its agent, and comes back with it.
-- NULL    - not disabled.
ALTER TABLE api_keys ADD COLUMN disabled_reason TEXT;

-- Anything already off was switched off by hand: the agent cascade did not
-- exist before this migration.
UPDATE api_keys SET disabled_reason = 'key' WHERE disabled_at IS NOT NULL;

-- And every key whose agent is already disabled becomes really disabled, so
-- the stored state matches what the screen has been showing and what
-- authentication has been enforcing. Enabling those agents will rotate these
-- keys, which is the new promise applied to the keys that predate it.
UPDATE api_keys
   SET disabled_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
       disabled_reason = 'agent'
 WHERE disabled_at IS NULL
   AND agent_id IN (SELECT id FROM agents WHERE status != 'active');
