# 020 · Two staff console defects

**Status:** Open — found by the 8 Sept 2026 audit ([summary.md](../summary.md) F-05, F-07)

Both are in the tooling around a suspension mechanism that is otherwise correct
— setting `workspaces.status` stops every key in the workspace on its next
request, without touching any key, because step 5 of the chain reads that column
every time.

**1. Fleet search throws in SQLite.** `staff/access.ts:200` is a double-quoted JS
string containing `ESCAPE '\\\\'`. Four source backslashes unescape to two, so
the SQL text reads `ESCAPE '\\'` — and SQLite does not process backslash escapes
inside string literals, so that is a **two-character** string where `ESCAPE`
requires exactly one. Every search fails.

The template-literal queries in `db/workspace-scoped.ts` get this right: two
source backslashes → one in the SQL. Measured:

```
staff ESCAPE arg length = 2   ← SQLite requires 1
ws    ESCAPE arg length = 1
```

The unsearched listing omits the clause entirely and works, which is why this is
invisible in casual use — but `apps/admin/src/api.js:83` does pass `q`, so any
staff search fails. Not an injection risk: the term itself is bound.
No test covers it.

**2. Force-logout succeeds, then 500s, and leaves no audit row.**
`routes/staff.ts` defaults `workspaceId` to `""` when the query parameter is
absent. `forceLogout` (`access.ts:255`) performs the `UPDATE users` **first**,
then calls `record(workspaceId, ...)`, which inserts into `audit_events` — whose
`workspace_id` is `NOT NULL REFERENCES workspaces(id)` (`migrations/0002:140`).
An empty string satisfies `NOT NULL` and fails the foreign key, so the insert
throws after the sessions are already revoked.

Three problems compound: the action succeeded but reports failure, so support
retries; the audit row is never written, which breaks the one contract
`StaffScopedAccess` exists to keep ("every method appends an audit event,
unconditionally, including reads"); and `apps/admin/src/api.js:89` builds
`?workspaceId=${workspaceId}` with no guard, so an undefined argument sends the
literal string `undefined` and fails the same key.

The `await` on the record is deliberate and right — a staff action that could not
be recorded should not be reported as having happened — but the ordering inverts
the intent.

**To close:** fix the escape literal; make `workspaceId` required on force-logout
and reject a blank one before the update.
