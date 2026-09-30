-- The plan override moves from the workspace to the billing account.
--
-- Migration 0017 moved usage up to the organization but left the CEILING on
-- the workspace, and the two halves disagreed. One account, two workspaces, an
-- override on one of them: the same shared pool of bytes was checked against
-- Basic through one workspace and Free through the other, so which limit
-- applied depended on which workspace you happened to write through. That is
-- the loophole 0017 closed, reopened through a staff action.
--
-- The override is kept rather than deleted, because the need behind it is
-- real - an operator has to be able to give one customer more room without
-- editing the plan everybody shares. What changes is its scope: it is an
-- account-level override now, which is the same unit as the subscription it
-- overrides.
--
-- The backfill takes the workspace override that resolves to the MOST
-- GENEROUS storage allowance, not an arbitrary one. Collapsing several
-- per-workspace grants into one account grant has to round in the direction
-- that cannot break a running tenant: rounding down would take away room a
-- workspace is already using, and the first symptom would be writes failing
-- for somebody who was explicitly granted the space. Rounding up costs money
-- and is visible in the console.
--
-- `workspaces.plan_override` is then dropped outright. Leaving a column that
-- nothing reads is how somebody sets it six months from now, sees the console
-- report the new plan, and cannot work out why the limits never moved.

ALTER TABLE organizations ADD COLUMN plan_override TEXT;

UPDATE organizations
   SET plan_override = (
         SELECT w.plan_override
           FROM workspaces w
           JOIN plans p ON p.id = w.plan_override
          WHERE w.org_id = organizations.id
            AND w.plan_override IS NOT NULL
          ORDER BY p.storage_bytes DESC
          LIMIT 1
       )
 WHERE EXISTS (
         SELECT 1 FROM workspaces w
          WHERE w.org_id = organizations.id
            AND w.plan_override IS NOT NULL
       );

ALTER TABLE workspaces DROP COLUMN plan_override;
