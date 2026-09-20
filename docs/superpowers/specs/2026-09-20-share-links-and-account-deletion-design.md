# Public share links, a 7-day deletion window, and self-serve account deletion

**Status:** design, approved in brainstorming 20 September 2026 · not yet planned
**Supersedes:** nothing. Extends 05 PART 12.4, which reserved the idea and was
never built.

Three changes ship together because they are one story: a share link is a new
thing that account deletion has to destroy, and the account-deletion dialog has
to quote the retention window that part 2 changes. Splitting them would mean
writing the dialog copy twice.

| Part | What | Independent? |
|---|---|---|
| 1 | Public share links for a file or folder, expiring, gated off the free plan | Yes — could ship alone |
| 2 | Deletion grace period 30 days → 7 days | Yes |
| 3 | Self-serve account deletion, with a dialog that tells the truth | Depends on 1 and 2 for its copy |

---

## Part 1 — Public share links

### What a customer gets

A member shares a file or a folder and receives a link:

```
https://app-dev.agentdisk.io/s/<token>
```

Anyone holding it can open the page and download, with no account and no
credential. It expires — 7 days by default, with 1 hour / 24 hours / 7 days
presets and a custom date, capped at 7 days. It can be revoked at any moment.

The free plan cannot create them.

### Mechanism: our route, not a raw presigned URL

The public route resolves the token, checks expiry, then **302s to a freshly
minted 1-hour presigned R2 GET**.

The rejected alternative was handing out a 7-day presigned R2 URL directly: no
table, no route, almost no code. It was rejected because a presigned URL is
valid until it expires wherever it has been forwarded, so that design has **no
revoke**, cannot list what is currently public, can never raise the 7-day
ceiling (SigV4's own maximum), and puts the bucket hostname in front of
customers.

Because the share's lifetime is now ours rather than SigV4's, the 7-day cap
becomes policy — PART 12.4's — rather than a constraint. Written down because a
future request to allow 30-day links is now a one-line change, and whoever gets
that request should know the architecture already permits it.

### Schema — migration `0016_share_links.sql`

```sql
CREATE TABLE share_links (
  id            TEXT PRIMARY KEY,               -- shr_<ulid>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('file','folder')),
  file_id       TEXT REFERENCES files(id) ON DELETE CASCADE,
  folder_path   TEXT,
  token         TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  CHECK ((kind = 'file'   AND file_id IS NOT NULL AND folder_path IS NULL)
      OR (kind = 'folder' AND folder_path IS NOT NULL AND file_id IS NULL))
);

CREATE UNIQUE INDEX idx_share_links_token ON share_links(token_hash);
CREATE INDEX idx_share_links_workspace ON share_links(workspace_id, expires_at);
CREATE INDEX idx_share_links_file ON share_links(file_id);
```

Add `shareLink: "shr"` to `ID_PREFIX` in `lib/ids.ts`.

Four decisions in that DDL are load-bearing:

**`ON DELETE CASCADE`, the first in this schema.** Fifteen migrations use it
nowhere; every cascade here is written by hand, and CLAUDE.md carries a rule
about clearing inbound foreign keys before deleting a subtree. That rule exists
because `folders.parent_folder_id` is self-referencing and `files` is referenced
from several places, so ordering genuinely matters. `share_links` is a leaf —
nothing references it — so there is no ordering puzzle, and the database can do
the work. Doing it by hand instead would mean remembering to add a DELETE to
both `db/workspace-cascade.ts` and `jobs/purge.ts`; forgetting either one turns
a foreign-key violation into a **broken workspace delete and a silently failing
hourly cron**. The cascade converts "must remember" into "cannot forget."

**A folder share stores `folder_path`, never `folder_id`.** CLAUDE.md already
requires that folder emptiness be decided by path, because folders are created
lazily and a file can sit inside one with `folder_id` still NULL. The same
reasoning applies harder here: a `folder_id` query would silently **under-share**
and the customer would report missing files. Storing the path also means a share
survives a folder row that was never created.

**`token` is stored in cleartext, and this deliberately breaks the pattern.**
`api_keys.key_hash` and `workspaces.claim_token_hash` are hash-only, and
`lib/claim.ts` has a long header explaining that a token rebuildable on an
arbitrary request is a token stored in cleartext. That reasoning still holds for
those two. It does not transfer, because a share token grants read access to
bytes the owner has already chosen to publish, not "own this workspace" — it is
revocable, it dies within 7 days, and a link you cannot copy twice is not a
share feature. **State the consequence plainly in the file header: a D1 dump
contains live share URLs.** `token_hash` is kept as the lookup index so the
public route's hot path never does a cleartext comparison.

**There is no `revoked_at`.** Revoking deletes the row. That removes a state,
and with it the class of bug where a missed revocation check serves bytes from a
row that should be dead. The public route's answer for a revoked token is then
identical to its answer for one that never existed, which is the property we
wanted anyway.

### Routes

| Route | Op | Notes |
|---|---|---|
| `POST /v1/shares` | `share` | `{fileId}` or `{path}`, optional `expiresAt` |
| `GET /v1/shares` | `list` | live links in the workspace |
| `DELETE /v1/shares/:id` | `share` | deletes the row |
| `GET /v1/shares/open/:token` | **public** | preview JSON |
| `GET /v1/shares/open/:token/download/:fileId` | **public** | 302 → 1-hour presigned |

`:fileId` is carried on the download route for both kinds, not just folders. For
`kind = 'file'` it must equal the share's own `file_id` and is otherwise
refused — redundant by construction, and deliberately so: one download route
with one containment check is harder to get wrong than two routes where only
one of them checks.

**Every refusal on the two public routes returns `404` with one fixed body.**
Expired, revoked, never-existed, wrong workspace, soft-deleted file, suspended
workspace and a `fileId` outside the shared path are indistinguishable to the
caller. The reason goes to the log, never the response.

One creator endpoint rather than one per kind, so the plan check and the live
count exist in exactly one place.

`open` is a literal segment placed **before** the `:id` patterns.
`workspaces/needs-attention` was swallowed by the `:id` route above it and
answered 404, which reads like a data problem rather than the routing one it is;
`staff-console.test.ts` pins three such cases and these two belong in that
family.

The two public routes register above `withAuth`, in `index.ts`, beside the claim
route — which is the existing precedent for a no-credential, token-in-URL route
and should be read before writing these.

### The public page

`app-dev.agentdisk.io/s/:token`, modelled on `routes/Claim.jsx`: a public SPA
route, no shell chrome, that calls the preview endpoint and renders either one
file with a download button or a folder listing. `previewClaim` +
`Claim.jsx` is the pattern to copy wholesale.

### Folder shares are live and recursive

The link resolves the subtree at view time — `path` prefix match — so a file
added to a shared folder tomorrow is public tomorrow. This is how every other
file-sharing product behaves and is what people will expect.

The security consequence is real and must be **stated in the share dialog, not
buried**: anything added to this folder becomes public, with no second decision.
The Files screen shows the live count and total size of what a folder link
currently exposes, so "what is public right now" is always answerable.

**Containment is a segment-boundary match, not `startsWith`.** A share of
`/reports` must not serve `/reports-private/secrets.md`. This is the identical
bug class that `scopeAllowsOp` already solves; reuse `normalizePrefix` and the
matching helper in `auth/scopes.ts` rather than writing a second, subtly
different definition.

### The plan gate

Add `shareLinks` to `PlanLimits`:

| Plan | `shareLinks` |
|---|---|
| free | 0 |
| basic | 10 |
| pro | 100 |
| team | `UNLIMITED` |
| `SANDBOX_LIMITS` | 0 |

Zero reads as a wall with no special case in the enforcement code, and because
`PlanLimits` mirrors into the D1 `plans` table the number is editable from the
staff console without a deploy. A sandbox gets 0 because an anonymous,
unclaimed, Turnstile-gated workspace must not be able to mint public links.

Because `shareLinks` is a required field on the interface, the compiler names
every site that has to change: the four `PLAN_LIMITS` entries, `SANDBOX_LIMITS`,
`limitsFromRow`, and a limits-shaped literal in `test/claim.test.ts`. Also
needed, and not compiler-enforced:

- a `share_links INTEGER` column on the `plans` table, following the
  `null` = defer to floor, `-1` = unlimited convention of migration 0012;
- `PlanRow`, `floorFor` and `limitsFromRow` field mapping;
- the staff console plan editor;
- **`metadataForPlan` in `billing/plan-sync.ts` and its decoder, changed
  together** — CLAUDE.md is explicit that separating the two directions of that
  translation is how they drift, and the drift shows as an edit that appears to
  work and then quietly changes the entitlement it just set.

The limit counts rows that have not expired. Revoking frees a slot immediately,
because revoking deletes the row.

### The `share` scope op

Add `"share"` to `SCOPE_OPS`. This is backward-compatible: `parseScopes` fails
closed on *unknown* ops, and adding a known one cannot invalidate a stored blob.

**`auth/roles.ts:31` must change too.** `FULL_OPS` is a hardcoded array rather
than a derivation of `SCOPE_OPS`, so adding the op changes nothing for roles
until that line is updated — and a dashboard owner would find Share silently
unavailable. Failing in that direction is safe, but it will waste an afternoon
if it is not written down.

`routes/keys.ts:37` builds its zod enum **from** `SCOPE_OPS`, so the
key-creation API starts accepting `share` the moment the constant changes,
without anyone editing that file. Intended; noted so it is not a surprise.

No MCP tool. Making data public is a decision with no undo once the link is out,
and it stays with a person — the same reasoning that makes `DELETE
/v1/workspaces/:id` refuse an API key outright. An agent can only share if a
human deliberately mints a key carrying an op that is off by default.

Check how `McpConnection.jsx` renders the `read`/`write`/`delete`/`list` badge
vocabulary, so an op with no tool behind it does not render oddly.

### Deleted files

- **Soft-deleted** (the 24-hour trash): the row survives, so the share row
  survives. The public route serves nothing while `status != 'active'`.
- **Restored** within the window: the link works again, if it has not expired.
  Undoing a delete must not silently destroy a link already handed out.
- **Purged** after the window: the file row goes and the cascade takes the share
  row with it.

### Revocation is deletion, everywhere

`DELETE FROM share_links` is the only revocation mechanism. Three triggers:

1. The owner revokes one from the dashboard.
2. **A user is deleted or disabled** → every link they created, matching the
   existing `UPDATE api_keys SET revoked_at = ...` at
   `staff/users-access.ts:387` and `staff/access.ts:327`. Add the delete beside
   those statements, in the same operation.
3. **A workspace is suspended or deleted by staff**
   (`staff/access.ts:467`) → every link in it, whoever made it. A suspended
   workspace must not keep serving public downloads.

Triggers 2 and 3 close a real hole. A share link is anonymous, so it never
reaches `resolveVerifiedUser` and never sees `users.deleted_at`. Without these,
a deleted account's files stay publicly downloadable for the whole grace period
while its owner is locked out.

**Because the row is destroyed, nothing records what was public.** So:

- `share.created` is audited, with the path, kind and expiry.
- `share.revoked` is audited, including the bulk deletions from triggers 2 and 3.

`audit_events` is workspace-scoped and survives an account restore, so "what was
publicly exposed before this account was deleted?" stays answerable. Without
these two events a hard delete erases the only evidence.

This diverges from API keys, which stay as revoked rows. Deliberate — a key is a
credential with a usage history worth keeping, a share link is a disposable
pointer — and recorded here so nobody later "fixes" the inconsistency.

Expired rows are swept by the existing hourly purge cron — a
`DELETE FROM share_links WHERE expires_at <= ?` added to `jobs/purge.ts`. An
expired row serves nothing either way, so this is housekeeping rather than
enforcement; the plan limit counts unexpired rows and is correct whether or not
the sweep has run.

### Dashboard

- A **Share** action on file rows and folder rows in `FileBrowser.jsx`.
- A modal: expiry presets plus a custom date, the copy field, and for a folder
  the live "N files, X MB are public" count and the warning that additions
  become public.
- A shared badge and a revoke control on the row. Colour never carries meaning
  alone, so the badge pairs a tone with a word.
- The new public `/s/:token` page.
- On free, the action renders **disabled with the reason in words** and a link
  to upgrade, computed from the workspace's real plan. CLAUDE.md's rule — a
  screen that contradicts the entitlement model teaches people to distrust the
  thing protecting them — applies directly.
- The modal is additive, so any `ConfirmModal` in this flow passes
  `destructive={false}`. Revoking is destructive and keeps the default.
- Modals stay siblings of the drawer, never children.

### What the tests must pin — `test/shares.test.ts`

1. Expired, revoked and never-existed tokens produce **one identical response**.
   A distinguishable failure is an oracle, the same reason every authentication
   failure returns one body.
2. A soft-deleted file behind a live link serves nothing; a restore brings it
   back.
3. A share of `/reports` does not serve `/reports-private/secrets.md`.
4. A `fileId` from another workspace, passed with a valid token, resolves to
   nothing.
5. Free and sandbox cannot create a share; basic can, up to its limit; revoking
   frees a slot.
6. Deleting a user deletes their links. Suspending a workspace deletes its links.
7. Purging a file deletes its share row; deleting a workspace deletes its share
   rows — and neither operation fails on a foreign key.
8. **Both public routes are added to `test/auth.test.ts`'s table as deliberately
   public.** That sweep covers 41 routes precisely to catch a route added outside
   `withAuth`; two landing silently is the failure it exists for.

---

## Part 2 — The deletion window becomes 7 days

`STAFF_PURGE_WINDOW_MS` in `jobs/staff-purge.ts:34`, from 30 days to 7. It
governs both account and workspace deletion.

Everything else is text that must agree with it:

- **`apps/web/src/routes/Legal.jsx:218`** — "permanently purged within roughly 30
  days". This is the privacy policy and therefore a **stated retention
  promise**, not a constant. Settings → Privacy is a summary of Legal.jsx and
  moves with it; CLAUDE.md records that these two have already drifted once.
- `apps/admin/src/screens/Users.jsx:213, 408, 441` — three staff console strings.

**Things that say 30 and must not change:** `CLAIM_TOKEN_TTL_MS`
(`db/bootstrap.ts:37`), `periodResetAt` (`db/user-lookup.ts:24`, the billing
period despite the nearby comment), and the 30-day range selectors in Activity,
Usage and Keys.

Also update the doc comments that narrate "the 30-day sweep" —
`jobs/staff-purge.ts:2`, `index.ts:141`, `index.ts:786`, `db/user-lookup.ts:36`.

The motivation given was storage cost. Recorded honestly, because the number may
be revisited: at R2's $0.015/GB-month the saving is about a cent per deleted
free account and roughly $5.75 on a full 500 GB team account. It is not
material at the bottom of the range, and it bites hardest on exactly the
accounts most likely to ask for a restore. The better argument for 7 days is
that it is a cleaner promise to make and to honour, and that is the reason to
keep it.

Support must never promise a month. The console strings above are the only place
they would read it.

---

## Part 3 — Self-serve account deletion

Today only staff can delete an account. This adds the customer's own button, in
Settings, beside the existing workspace Danger zone.

### The rule for shared workspaces

**Everything the account owns is destroyed, and the dialog names what and who.**
The account is the billing account; what it pays for goes with it.

The dialog lists each affected workspace and how many people lose access. This
was chosen over refusing until the person is a sole member, and over
auto-transferring to a senior admin — the latter silently moves a billing
relationship onto somebody who never agreed to it and may have no card on file.

The chosen option's cost is real and should not be softened in the copy: a
colleague can lose their work because somebody else closed their account. The
naming of affected workspaces and member counts is what makes that a decision
rather than a surprise.

### The dialog

> **Delete your account?**
>
> **This happens immediately:**
> - Every API key you created stops working. Agents using them lose access at once.
> - Every share link you created is deleted. Anyone holding one gets nothing.
> - You're signed out everywhere.
> - Your subscription is cancelled. No further charges.
>
> **These are destroyed after 7 days:**
> - *Acme Reports* — 3 other members lose access
> - *Client Files* — 1 other member loses access
>
> **You cannot undo this yourself.** For 7 days, support can reverse it —
> contact us at agentdisk.io/support. After 7 days nothing can be recovered, by
> anyone.
>
> Type your email address to confirm.

Typing the email confirms the operation rather than the client, the same
reasoning that makes `DELETE /v1/workspaces/:id` require the workspace name in
the body.

The two-part structure is the point: the immediate consequences are irreversible
today, the destruction is a week away, and the support path is real but bounded.
A single "this cannot be undone" would be both too strong and too weak.

### The endpoint

`DELETE /v1/me`, with the confirming email in the request body. A DELETE
carrying a body is already this product's shape for a destructive confirmation —
`DELETE /v1/workspaces/:id` requires the workspace name the same way, so the
confirmation belongs to the operation rather than to one client.

- **Firebase session only.** An API key must be refused outright, like
  `DELETE /v1/workspaces/:id`. An agent must not be able to close its owner's
  account.
- Requires the caller's own email in the body.
- Reuses `staff/users-access.ts`'s deletion path rather than a second
  implementation — it already sets `deleted_at` and `session_revoked_after`,
  revokes keys, and is the thing `purgeStaffDeleted` knows how to finish. This
  route is a second, self-serve entry into one mechanism.
- Cancels the Stripe subscription.
- Deletes share links, per Part 1's trigger 2.
- Audited. The actor is the customer, not a staff member, and the audit row must
  say so.

### Tests

- An API key is refused.
- A wrong email is refused.
- Keys are revoked and share links deleted in the same operation.
- The account is refused entry afterwards by `resolveVerifiedUser`, immediately,
  without depending on Firebase's `disableUser` having succeeded.
- Staff restore inside 7 days works; keys and links do **not** come back, and the
  dialog copy does not claim they will.
- `purgeStaffDeleted` still defaults to reporting. It needs
  `STAFF_PURGE_ENABLED = "true"` to delete anything, and that must not change —
  dev holds accounts that this shortened window makes immediately eligible.

---

## Sequencing

Part 1 is the largest and is independently shippable. Part 2 is a constant and
four pieces of text. Part 3 depends on both for its copy and for what it
deletes.

Build order: **1 → 2 → 3**. Part 2 before Part 3 so the dialog is never written
against a number that is about to change.

Each part is its own commit, and the implementation plan should treat them as
three sequential phases rather than one undifferentiated list. Part 1 alone
touches a migration, the plan catalogue, the scope model, two public routes and
three screens; bundling Part 3's work into the same phase would make the first
reviewable checkpoint far too large.

## Deliberately not in scope

- **Password-protected links.** Not requested; adds a credential to a surface
  whose whole point is not having one.
- **Download counts and max-download limits.** Every hit becomes a D1 write on a
  hot public path, with concurrency to settle, for a feature nobody has asked
  for.
- **An MCP `share_file` tool.** See Part 1.
- **Links longer than 7 days.** The architecture now permits it; the policy does
  not.
- **Transferring workspace ownership.** It would make the refuse-first option in
  Part 3 viable and is worth having on its own merits, but it is a separate
  feature and Part 3 was resolved without it.
