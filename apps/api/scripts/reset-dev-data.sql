-- Wipe every tenant row from a dev database. TEMPORARY — see reset-dev.yml.
--
-- Only ever run by `.github/workflows/reset-dev.yml`, which is dispatch-only,
-- refuses any environment but dev, and requires the D1 name typed back before
-- it will run. Nothing in the Worker reaches this file: it is not a route and
-- not a staff action, so there is no deployed code path that can be tricked
-- into executing it. That is the whole reason this is a pipeline rather than a
-- button in the console.
--
-- ── What survives, and why each one would hurt ─────────────────────────────
--
--   d1_migrations    wrangler's own bookkeeping. Wipe it and the next deploy
--                    replays all 17 migrations against a schema that already
--                    has them, so every ALTER fails and the deploy dies.
--   staff_users      the console's entire access model is an email in this
--                    table (0014). Empty it and nobody can sign in to the
--                    admin app again — including whoever pressed the button.
--                    Migration 0014 seeds the first administrator, but it will
--                    not re-run; see d1_migrations above.
--   plans            the plan catalogue, populated BY HAND from the Stripe
--                    dashboard and deliberately not in Terraform (CLAUDE.md).
--                    There is no pipeline that would put it back.
--   schema_bootstrap the bootstrap marker.
--
-- ── Ordering is load-bearing ──────────────────────────────────────────────
-- Same discipline as `db/workspace-cascade.ts`: SQLite checks foreign keys
-- immediately and deletes rows within one statement in arbitrary order, so
-- every inbound reference is cleared to NULL before anything is removed and
-- the removals run child-first. `folders.parent_folder_id` is self-
-- referencing and `files.folder_id` is referenced from outside; both fail
-- whichever way a single DELETE is written.

UPDATE files   SET folder_id        = NULL;
UPDATE folders SET parent_folder_id = NULL;

DELETE FROM file_tags;
DELETE FROM share_links;
DELETE FROM files;
DELETE FROM folders;

-- Bytes queued by a workspace delete, and the record of the sweeps that were
-- meant to remove them. No foreign keys on either - every row they name is
-- already gone - so they are cleared for completeness rather than ordering.
-- Leaving pending_deletions behind would point a later sweep at R2 objects
-- whose workspaces this script just destroyed.
DELETE FROM pending_deletions;
DELETE FROM job_runs;

-- Keys before agents: api_keys.agent_id points at agents.
DELETE FROM api_keys;
DELETE FROM agents;
DELETE FROM webhooks;
DELETE FROM audit_events;

-- The staff log goes too. It is a record of actions against tenants that no
-- longer exist, and every actor id in it would dangle.
DELETE FROM staff_actions;

-- Workspaces before organizations (workspaces.org_id), organizations before
-- users (organizations.owner_user_id).
DELETE FROM memberships;
DELETE FROM workspaces;
DELETE FROM organizations;
DELETE FROM users;
