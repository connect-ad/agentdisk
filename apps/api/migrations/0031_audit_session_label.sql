-- Which session made each write, 27 Sept 2026.
--
-- The audit log already says which agent (the key's actor) did what. It could
-- not say which *run* of that agent: a scheduled job that fires hourly, or a
-- model that is restarted between tasks, shares one key across every session,
-- so the log showed one actor doing everything. A client may now send an
-- `X-AgentDisk-Session` header naming its session, model or run, and it is
-- stored here beside the row.
--
-- It is a label, never an identity. It is client-supplied and unverified, so
-- nothing authorizes on it and nothing joins on it; it is for a person reading
-- the log. Bounded to 120 characters and stripped of control characters at the
-- write, for the same reason `client` is truncated. NULL means the caller sent
-- none, which is every caller that existed before today.

ALTER TABLE audit_events ADD COLUMN session_label TEXT;
