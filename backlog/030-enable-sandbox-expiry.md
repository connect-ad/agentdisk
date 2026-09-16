# 030 — Turn on the unclaimed-sandbox sweep

**Status:** Open — shipped in log-only mode, deliberately. Not yet deleting anything.

Workspace claiming is built: `POST /v1/workspaces` now returns a claim link, and
`GET`/`POST /v1/workspaces/claim/:token` preview and take ownership, either as a
new workspace or merged into an existing one. The last piece — reclaiming
sandboxes nobody ever claims — is deployed but **switched off**.

## Why it is off

`jobs/sandbox-expiry.ts` deletes unclaimed workspaces older than 7 days, and
that delete is not soft: `deleteWorkspaceCascade` removes the R2 objects and
then the rows, and the rows are the only record that the objects existed.

The dev environment already holds weeks of unclaimed sandboxes from earlier
testing. Every one of them is expired by this job's definition, so a
delete-enabled first deploy would destroy all of them on the first cron tick,
with no review and no undo.

So `expireUnclaimedWorkspaces` takes `dryRun` and **defaults it to true**, and
`scheduled()` passes false only when `SANDBOX_EXPIRY_ENABLED` is exactly the
string `"true"`. The variable is declared as `"false"` in both `wrangler.toml`
environments, so switching it on is a visible diff rather than an absent default.

## What to do

1. Let it run for at least one full TTL window (7 days).
2. Read the `sandbox expiry candidates (dry run - nothing deleted)` log lines.
   Each carries every candidate's ID, name, age in days, file count and bytes.
3. Confirm the list is only genuinely abandoned test workspaces.
4. Set `SANDBOX_EXPIRY_ENABLED = "true"` on `dev`, watch one tick, then `prod`.

The job re-asserts `claimed_at IS NULL` per workspace inside the delete loop, so
a workspace claimed between the query and the delete is skipped — deleting one
somebody had just claimed is the single unrecoverable mistake it could make, and
there is a test for it.

## Open decisions, carried from the build

- **The sandbox limits are a placeholder and have not been confirmed with
  product.** `SANDBOX_LIMITS` in `lib/plans.ts` is 50 MB / 500 files / 500 MB
  egress / 10,000 requests, with `maxFileBytes` deliberately left at the free
  plan's 100 MB (it is a per-file ceiling, not an allowance; shrinking it would
  fail the first file an evaluator tries). These were proposed, not decided.
- **The 7-day TTL** is likewise a proposal, matching the competitor this is
  modelled on. It is a parameter on the job, not a constant baked into a query.

## Related drift found while building this

The design docs and the shipped dashboard disagree about the quota warning
thresholds, and the code is the one that ships:

- `apps/web/src/components-local/WorkspaceStats.jsx:114` uses **75% / 90%**.
- `docs/design/03-ux-architecture-and-screens.md` (lines 54, 217, 352),
  `docs/design/04-claude-design-prompt.md` (lines 149, 165) and
  `docs/design/23-theme-fidelity-diagnosis-and-fix-prompt.md` all say
  **80% / 95%**.

Per CLAUDE.md's precedence rule the docs should be corrected to 75/90. They were
left alone here because doc 23 is an in-flight theme-migration prompt being
actively worked, and rewriting the numbers underneath it would collide with that
work. The new claim page follows the code (75/90).

Separately, doc 28's PART 6 cites `25-theme-fix-verified-pending-deploy.md` as
the authority for 75/90. **That file does not exist in this repo** —
`docs/design/` goes 00–19 plus untracked 23 and 28. The 75/90 figure is
trustworthy only because `WorkspaceStats.jsx` implements it.

## Note on `claimUrl` in the quota warning

Doc 28's PART 4.3 asks the sandbox quota warning to carry a `claimUrl` with the
raw token. It cannot, and the reason is in `lib/claim.ts`'s header: the same doc
requires that only the token's SHA-256 is stored. A token rebuildable on an
arbitrary request is a token stored in cleartext. Hash-only storage won; the
warning carries `claimEntryUrl` (the claim page, no token) plus the workspace ID,
and the tokenised link appears only in the provisioning response, where the raw
token legitimately exists for one moment.
