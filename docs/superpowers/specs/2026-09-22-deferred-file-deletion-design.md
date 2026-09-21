# Deferred file deletion on workspace delete

Designed 22 September 2026. Supersedes the synchronous half of
`db/workspace-cascade.ts` for one of its four callers.

## The change in one paragraph

Deleting a workspace stops being one atomic act. Every credential that can
reach it — API keys, agents, webhooks, share links — is destroyed in the
request, along with the workspace row itself and all of its metadata. The file
rows move out of `files` into a new `pending_deletions` table, and the R2
objects are left alone. A sweep deletes those objects seven days later, driven
by the hourly cron or by a staff member clicking a button. The staff console
gains a section showing what is queued, what each run did, and a control to run
one now.

## Why

A workspace delete today destroys up to a tenant's entire byte inventory inside
a single HTTP request. Three things follow from that, and all three are
problems:

1. **It is unbounded.** `deleteWorkspaceCascade` reads every `files` row and
   issues an R2 delete per 1000 keys. A workspace holding a hundred thousand
   objects makes a hundred sequential round trips inside a request budget that
   was sized for one. Nothing in the code caps it.
2. **A half-finished run is silent.** The R2 deletes are not in the D1 batch. A
   failure after the objects are gone rolls the rows back and reports an error,
   leaving a workspace that still exists and whose files no longer do.
3. **There is no interval in which anybody can look.** The bytes are gone
   before the response is written, so an accidental deletion is unrecoverable
   from the moment it is confirmed.

Deferring the byte deletion fixes all three. It does not soften the customer
promise, because the workspace, its keys and its entire surface really are gone
immediately — what defers is only the part nobody can observe.

## Scope: one caller, not four

`deleteWorkspaceCascade` has four callers. Only the customer-initiated route
defers:

| Caller | Defers? | Why |
|---|---|---|
| `routes/workspaces.ts` — a person deleting their workspace | **Yes** | The case this spec is about |
| `routes/claim.ts` — sandbox cleanup after a merge | No | Its files were already moved away; there is nothing to defer |
| `jobs/sandbox-expiry.ts` — the unclaimed sweep | No | Already waited 7 days |
| `jobs/staff-purge.ts` — the staff 30-day sweep | No | Already waited 30 days |

Deferring in the last two would double an existing grace period, which is not a
safety improvement — it is a second window nobody asked for and nobody is
watching. `deleteWorkspaceCascade` therefore takes a `defer` flag, default
`false`, and only the route passes `true`.

## What happens at the click

Unchanged from today, in the same FK-safe order, all inside the existing
`db.batch`:

- `files.folder_id` to NULL, `folders.parent_folder_id` to NULL
- `file_tags` for this workspace's files
- **`staff_actions.workspace_id` to NULL** — new; see "The FK that blocks this"
- `api_keys`, then `agents` (keys first: `api_keys.agent_id` points at `agents`)
- `webhooks`, `audit_events`, `memberships WHERE workspace_id = ?`
- `folders`
- the `workspaces` row — which cascades `share_links` away via migration 0016

Changed:

- Instead of `DELETE FROM files`, the rows are **copied into
  `pending_deletions` and then deleted from `files`**, in the same batch.
- The R2 deletes do not happen.

The copy is one `INSERT ... SELECT`, not a read into the Worker followed by a
row-by-row insert. The columns that come from outside the `files` row — the
workspace name, `deleted_by`, `marked_at`, `due_at`, `source` — are bound as
literals in the SELECT list beside the selected columns:

```sql
INSERT INTO pending_deletions
  (file_id, r2_object_key, size_bytes, path, name,
   workspace_id, workspace_name, org_id, deleted_by, source,
   marked_at, due_at, attempts, last_error)
SELECT f.id, f.r2_object_key, f.size_bytes, f.path, f.name,
       f.workspace_id, ?, ?, ?, 'workspace_delete',
       ?, ?, 0, NULL
  FROM files f WHERE f.workspace_id = ?;
```

That keeps the whole move inside the same `db.batch` as the deletes, so it is
atomic with them. A loop would not be, and a workspace whose rows were half
moved when the request died would be the one state nothing can clean up.

`deleteWorkspaceCascade` therefore takes an options object rather than a bare
boolean: `{ defer: true, workspaceName, deletedBy, now }`. Without the name and
the actor it cannot write a `pending_deletions` row, and both are already in
hand at the one call site that defers.

`share_links` deserves a note because it was not in the original request and
must not be forgotten: a share token is a live public URL to the bytes, stored
in cleartext. It dies with the keys, not with the objects. The `ON DELETE
CASCADE` on `share_links.workspace_id` already guarantees this, which is
exactly why that cascade was written into the schema.

## Detachment is structural, not a flag

The original request asked for files to be marked `ready_to_delete` and
detached from the workspace and the account. Two facts make a status flag on
`files` the wrong mechanism:

- `files.workspace_id` is `NOT NULL REFERENCES workspaces(id)`. A hard-deleted
  workspace cannot leave rows behind in that table. Making it able to means a
  full SQLite table rebuild of the largest, hottest table in the schema, to
  weaken a constraint that is correct for every other row in it.
- An R2 key is `tenant/{workspaceId}/{fileId}` and nothing else. The workspace
  ID **is** the object's physical address. Detaching the bytes would mean
  copying every object to a new key and deleting the old one — for data that is
  about to be destroyed.

Moving the rows to their own table gives the stronger property for less work.
The row is no longer in `files` at all, so no scoped repository, no search, no
listing, no quota query and no future query can return it. There is nothing to
remember to filter, which is the same reason `share_links` was given a real
`ON DELETE CASCADE`: "cannot forget" beats "must remember".

The `r2_object_key` keeps naming a workspace that no longer exists. That is
fine and deliberate — it is an address, not a reference, and workspace IDs are
ULIDs that are never reused.

### The cost, stated plainly

**Restore becomes impossible.** Once the workspace row and the folder tree are
gone you hold a flat list of object keys and display paths. Bytes could be
recovered by hand from that; a workspace could not be reconstituted. This is
inherent to hard-deleting the workspace, not to the table choice, and it was
accepted deliberately.

## Schema — migration 0017

```sql
CREATE TABLE pending_deletions (
  file_id         TEXT PRIMARY KEY,
  r2_object_key   TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  path            TEXT NOT NULL,
  name            TEXT NOT NULL,

  -- Denormalised, plain TEXT, no foreign keys. Every row these named is gone
  -- by the time this row exists, so a join is impossible rather than merely
  -- undesirable. Same reasoning as staff_actions.actor_email.
  workspace_id    TEXT NOT NULL,
  workspace_name  TEXT NOT NULL,
  org_id          TEXT NOT NULL,
  deleted_by      TEXT NOT NULL,
  source          TEXT NOT NULL,   -- 'workspace_delete' today; room for more

  marked_at       INTEGER NOT NULL,
  due_at          INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);
CREATE INDEX idx_pending_deletions_due ON pending_deletions(due_at);
CREATE INDEX idx_pending_deletions_workspace ON pending_deletions(workspace_id);
```

`due_at` is **stored, not computed** from `marked_at` at read time. Changing
the retention constant later must not retroactively move the due date of files
already queued under the old promise.

```sql
CREATE TABLE job_runs (
  id              TEXT PRIMARY KEY,
  job             TEXT NOT NULL,
  trigger         TEXT NOT NULL,   -- 'cron' | 'staff'
  actor_id        TEXT,            -- staff id when trigger = 'staff', else NULL
  actor_email     TEXT,
  dry_run         INTEGER NOT NULL,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  examined        INTEGER NOT NULL DEFAULT 0,
  objects_deleted INTEGER NOT NULL DEFAULT 0,
  rows_deleted    INTEGER NOT NULL DEFAULT 0,
  bytes_freed     INTEGER NOT NULL DEFAULT 0,
  failed          INTEGER NOT NULL DEFAULT 0,
  error           TEXT
);
CREATE INDEX idx_job_runs_job_started ON job_runs(job, started_at DESC);
```

`job_runs` exists because **"see last run activities" is not answerable
today**. All five jobs on the cron tick — reap, reconcile, sandbox expiry,
staff purge, share purge — write to `console.log` and nowhere else, and a
Worker cannot read its own logs. The table is shaped generically — a `job`
column rather than a table per job — so those five can start writing to it
later, but this spec wires up only the new one. Retrofitting the others is not
in scope.

`finished_at IS NULL` is a run that died mid-flight. The console renders that
as "interrupted" rather than hiding it, because a job that stopped reporting is
the thing you most want to see.

## The FK that blocks this

`staff_actions.workspace_id` is `TEXT REFERENCES workspaces(id)` with no
`ON DELETE` clause (migration 0011), and nothing in `apps/api/src` ever clears
it. Any workspace a staff member has ever acted on therefore **cannot be
deleted**: the final `DELETE FROM workspaces` raises a foreign-key violation,
the batch rolls back, and under today's code the R2 objects are already gone.

This is pre-existing and unrelated to the feature, but it sits in the exact
statement this work touches and it is guaranteed to fire on the staff purge
path — a workspace must be *suspended* before staff can delete it, and the
suspension writes precisely such a row. It is fixed here: one
`UPDATE staff_actions SET workspace_id = NULL WHERE workspace_id = ?` added to
the batch alongside the other NULL-clears.

Setting it to NULL rather than deleting the row is the point. The fleet log
keeps the record that staff acted; it loses only the pointer to a workspace
that no longer exists, which is the case migration 0011's nullable column was
written for.

## The sweep

`jobs/pending-deletions.ts`:

```ts
export async function sweepPendingDeletions(
  db: D1Database,
  files: R2Bucket,
  now: number,
  options: {
    dryRun?: boolean;   // default TRUE
    force?: boolean;    // ignore due_at
    limit?: number;     // default 500
  } = {}
): Promise<SweepResult>
```

Candidates are `due_at <= now` — or every row when `force` is set — ordered
`due_at ASC` so a backlog drains in the order it accumulated. Objects are
deleted in chunks of 1000, R2's per-call limit, then the rows.

**Objects before rows**, matching `jobs/purge.ts`. The row is the only record
that an object exists, so losing it first orphans bytes nothing can ever find.

**Already-gone is success, not failure.** R2's delete is idempotent; the
desired state is "no object", and a retry that finds nothing has reached it.

A per-file failure increments `attempts` and writes `last_error`, leaving the
row for the next run rather than failing the batch. A row whose `attempts`
climbs without bound is visible in the console listing, which is where that
belongs — it is an operator's judgement call, not a cron's.

### Dry run is the default

`dryRun` defaults to `true` in the signature, exactly as
`expireUnclaimedWorkspaces` does. Real deletion requires
`PENDING_DELETION_ENABLED === "true"` on the Worker env — the exact string, so
an unset, empty or misspelled value is safe.

This is not ceremony. Building and testing this feature queues rows whose due
dates fall during the work, and dev already holds weeks of test data. The first
deploy carrying a working sweep would, without the flag, destroy all of it on
the next hourly tick, unattended, with no undo and no second copy of the bytes.
With the flag that deploy prints a list instead. Read a window of those lines,
then set it.

A dry run still writes a `job_runs` row, with `dry_run = 1` and the counts it
*would* have achieved. A run you cannot see is not a report.

## Triggers

Two, sharing one function.

**The hourly cron.** Added to the existing `scheduled()` chain in `index.ts` as
a sixth job with its own try/catch, so it cannot take the other five down. No
new cron expression and no `event.cron` branching.

The 7-day window lives in `due_at`, not in the schedule. A weekly cron plus a
7-day window would mean a file marked on Monday waits until the following
Sunday's tick — up to 14 days — and a missed tick doubles that again. On the
hourly tick it is 7 days give or take an hour, and a missed tick self-heals.

**The staff button.** `POST /v1/staff/deletions/run` calls the same function.
Two switches on the request:

- `dryRun` — preview without deleting, available to any role that can run.
- `force` — take rows not yet due. **super_admin only**, reason required. This
  is the "a customer has asked for their data to be gone today" case, and it is
  the one control here that destroys something ahead of its promised schedule.

## Staff console

Three routes, one new area class, one new screen.

`src/staff/deletions-access.ts` extends `AuditedStaffAccess` like every other
area, so `record`, `recordFleet` and `requireRole` come with it and cannot be
skipped.

| Route | Role | Audited as |
|---|---|---|
| `GET /v1/staff/deletions` | support | read, not recorded |
| `GET /v1/staff/deletions/runs` | support | read, not recorded |
| `POST /v1/staff/deletions/run` | admin (super_admin for `force`) | `deletions.sweep` |

Reads are **support-readable** on purpose, matching the correction already made
for Billing and Plans: support is exactly who fields "I deleted a workspace by
mistake, where are my files", and for seven days that question has an answer in
this listing.

Audit rows go through `recordFleet`, not `record`. There is no workspace left
to scope the event to — which is the case `staff_actions`' nullable
`workspace_id` was created for, and the reason `audit_events` cannot hold these
rows.

`deletions/runs` and `deletions/run` are literal segments and must be matched
before any `:id` pattern in the same prefix, or they answer 404 in a way that
reads like a data problem. `staff-console.test.ts` already pins three other
routes against exactly this; these join them.

### The screen

`apps/admin/src/screens/Deletions.jsx`, following the existing nine: one
screen, History API routing, the console's own palette from `src/app.css` —
never the dashboard's tokens.

Two sections:

**Upcoming** — one row per queued file: name and path, size, former workspace
name and ID, who deleted it, when it was marked, when it comes due. Sorted by
due date. A header line carries the totals, because "4.2 GB across 1,812 files
in 3 workspaces" is the number an operator actually wants. Rows with
`attempts > 0` are marked with the error, paired with a word rather than colour
alone.

**Runs** — the `job_runs` history: when, what triggered it, who, dry run or
real, and the counts. A run with `finished_at IS NULL` reads "interrupted".

**Run now** opens a `ConfirmModal` with `destructive` left at its default of
true — this one genuinely is. The dialog states how many files and how many
bytes the run will take before it is confirmed, which means the preview query
runs first; that is `dryRun` doing double duty.

## API response

`DELETE /v1/workspaces/:id` returns `{ id, deleted: true, files, purgeAt }`
where `files` is now the count queued rather than deleted. The dashboard
discards this body entirely (`Settings.jsx:267`), so no customer-side frontend
work follows. `test/workspaces.test.ts` asserts the shape and must be updated.

## Not built

- Customer-facing restore. Impossible after a hard delete, as above.
- Retrofitting `job_runs` onto the reaper, reconciler, sandbox sweep and staff
  purge. The table is shaped to accept them; wiring them is separate work.
- A weekly cron trigger. The hourly tick with `due_at` eligibility strictly
  dominates it.
- Any change to the three non-deferring callers.

## Testing

- `test/pending-deletions.test.ts` — new. The sweep's eligibility window,
  `force`, dry run deleting nothing while still writing a run row, chunking
  past 1000 keys, an already-absent object counting as success, a failure
  incrementing `attempts` without failing the batch.
- `test/workspaces.test.ts` — keys, agents, webhooks and share links are gone
  the instant the request returns; the workspace 404s; the file rows are in
  `pending_deletions` and absent from `files`; the R2 objects still exist.
- `test/staff-console.test.ts` — the three routes' role gates, the literal
  segments not being swallowed, `force` refused below super_admin, the audit
  row written on a refusal as well as a success.
- A regression test for the `staff_actions` FK: a workspace with a staff action
  against it deletes cleanly.
- Quota: after a workspace delete, `reconcileCounters` no longer counts those
  bytes against the org. This falls out of the workspace row being gone — org
  usage joins through `workspaces` — but it is the billing behaviour and it
  should be pinned rather than inferred.

## Rollout

1. Ship with `PENDING_DELETION_ENABLED` unset. Deletions queue; nothing sweeps.
2. Read a week of `pending deletion candidates (dry run - nothing deleted)`
   lines and the console's Upcoming list. Confirm the selection.
3. Set the flag in the dev Worker environment. Watch one real run in the Runs
   section.
4. Prod never applies until dev has completed step 3 cleanly.
