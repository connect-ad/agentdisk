-- A readable URL slug per workspace.
--
-- Dashboard URLs addressed workspaces by their raw `ws_01K4M9XQ...` ID, which
-- nobody can read, retype, or recognise in a browser history. The slug is a
-- display concern only: it names no new authority, and the real ID keeps
-- addressing the workspace in every API call, MCP config snippet and the
-- Settings → Workspace ID field. `src/lib/slug.ts` explains why a slug can
-- never be mistaken for an ID (it cannot contain an underscore) and why it is
-- never regenerated on rename.
--
-- Uniqueness is per organization rather than global. Two unrelated accounts
-- may both hold `my-workspace`; a slug is only ever resolved against the
-- workspaces the caller can already reach, so a shared one leaks nothing.

ALTER TABLE workspaces ADD COLUMN slug TEXT;

-- Every existing row gets its own ID as a slug first. That is guaranteed
-- unique and guaranteed URL-safe, so this migration cannot fail on data it has
-- never seen, and the URL those workspaces already answer on keeps working
-- untouched while the statement below improves what it can.
UPDATE workspaces SET slug = id WHERE slug IS NULL;

-- Then upgrade the rows whose names slugify unambiguously in SQL.
--
-- This deliberately handles less than `slugify()` in TypeScript does. That
-- function normalises Unicode, strips diacritics and folds arbitrary
-- punctuation, none of which SQLite can do; reimplementing an approximation of
-- it here in nested replace() calls would be a second, subtly different
-- definition of the same thing - and the one that runs exactly once, on data
-- nobody would check afterwards. So the guard is strict: a name made only of
-- ASCII letters, digits, spaces and dashes, whose slug collides with nothing
-- else in the same organization. Everything else keeps the ID slug it just got
-- and is indistinguishable from today's behaviour.
WITH candidate AS (
  SELECT
    id,
    org_id,
    trim(
      replace(
        replace(
          replace(replace(lower(name), ' ', '-'), '--', '-'),
        '--', '-'),
      '--', '-'),
    '-') AS slug
  FROM workspaces
  -- No character outside the safe set anywhere in the name. GLOB, not LIKE:
  -- LIKE has no character classes and is case-insensitive by default.
  WHERE name NOT GLOB '*[^A-Za-z0-9 -]*'
),
usable AS (
  SELECT c.id, c.slug
    FROM candidate c
   WHERE c.slug <> ''
     -- Skip anything that would collide, rather than inventing a suffix here.
     -- A workspace keeping its ID slug is correct and reversible; a migration
     -- that trips the unique index below is neither.
     AND NOT EXISTS (
       SELECT 1 FROM candidate other
        WHERE other.org_id = c.org_id
          AND other.id <> c.id
          AND other.slug = c.slug
     )
)
UPDATE workspaces
   SET slug = (SELECT slug FROM usable WHERE usable.id = workspaces.id)
 WHERE id IN (SELECT id FROM usable);

CREATE UNIQUE INDEX idx_workspaces_org_slug ON workspaces(org_id, slug);
