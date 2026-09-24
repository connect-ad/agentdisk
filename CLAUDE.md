# AgentDisk

Serverless file storage built for AI agents. Files, folders and metadata over
REST and MCP — scoped credentials, hard-capped pricing, no servers to run.

---

## Information Route

Where each kind of knowledge lives. Read this before executing any development
task.

| Path | Holds | Rule |
|---|---|---|
| `CLAUDE.md` | This route and the catalog | Source of truth for *where things are*. Not a duplicate of the specs. **While parallel tracks are running, this file is owned by Track 0** — route edits through it rather than editing directly, or two sessions clobber the one file everything else trusts. See `coordination/DEFERRED.md` X-06. Treat the test counts in Status as a snapshot; re-measure after a merge. |
| `docs/design/` | The specification, `NN-<slug>.md` | 20 documents, PART 1–30. The product's design authority — but see the precedence rule below. |
| `design-system/` | Upstream mirror of the Claude Design project | **Read-only.** Byte-identical to the remote (96/96). Changes go into Claude Design, then re-import — never edit here. |
| `apps/api/` | The Cloudflare Worker: REST + MCP, one deployable | Both surfaces are built and share one authorization chain. MCP tools call the REST handlers rather than reimplementing them, so the two cannot drift — live testing once disputed this for `pathPrefix`, and retesting confirmed the code: both surfaces refuse a path outside the key's prefix, see `backlog/029`. |
| `infra/terraform/` | All infrastructure as code | One root config, one module, **one workspace per environment** (`dev`, `prod`). No `environments/` directories — see the workspace note below. |
| `.github/workflows/` | CI and deployment pipelines | **Three areas, split by what they own: `infra`, `backend`, `frontend`.** Each is one reusable engine plus thin per-environment callers, so prod can never drift from dev. Path filters mean an `apps/web` push moves nothing else. `frontend.yml` is called once per app (dashboard, console). `ci.yml` gates PRs and covers all three apps. `deploy-all-dev.yml` is the ordered manual full deploy. |
| `apps/admin/` | The internal admin console, at `securepanel-dev.agentdisk.io` | Its own origin, though no longer for the reason 14 PART 27.2 gives: that doc scopes a admin session cookie to this host so a admin and a customer credential cannot reach each other in a browser, and migration `0014_admin_firebase_sso.sql` deleted that cookie. Admin sign in with the same Firebase identity as customers and one token now reaches both surfaces; the separate origin survives as a way to tell the two apps apart, not as an isolation boundary. **The boundary is the `admin_users` lookup on every request** — see the rule below. Deliberately does not import `design-system/` — looking different from the customer dashboard is how a support engineer knows which one they are in; it carries its own palette in `src/app.css`, from the AgentDisk Admin design file, and those tokens must not be reconciled with the dashboard's. Nine screens under `src/screens/`, one shell, routing by the History API rather than a router library. |
| `apps/web/` | The dashboard SPA, live at `app-dev.agentdisk.io` | `src/components/` is vendored from `design-system/`; `src/components/index.js` is generated. Hand-written code lives in `src/routes/` and `src/components-local/`. Two vendored files deliberately diverge, all awaiting the same upstream trip: `src/components/AppShell.jsx` for three reasons — `backlog/015`, `backlog/016` and `backlog/026` — `src/components/Modal/Modal.jsx` plus `src/components/Button/Button.jsx`, which together gain Enter-to-submit, the one part of the modal contract that cannot be done from `app.css` — `Button` has to default to `type="button"` or an untyped Cancel inside the new `<form>` submits the dialog it exists to dismiss (`backlog/031`); and `src/components/ApiKeyDisplay/ApiKeyDisplay.jsx`, twice: its `prefix` defaulted to `ad_live` — a prefix this API has never issued — and its revealed-state note said "stored only as a hash, so we cannot show it again", which stopped being true when migration 0022 kept keys. Deployed as a Workers static-assets Worker, not Pages — see `backlog/013`. |
| `Skill/` | Reusable how-to knowledge, `<N> <Name>.md` | Procedures, commands and their calibration. Not the specification — that is `docs/design/`. |
| `backlog/` | Outstanding tasks, `NNN-<slug>.md` | **Three items: the billing module, the admin panel built on top of it, and one small Firebase fix.** The previous 31 were deleted 18 Sept 2026 and live at the tag `pre-billing-module`. Status lives in each file. |
| `docs/superpowers/specs/` | The design rebuild's specs, `YYYY-MM-DD-<slug>.md` | Replaced `.design-sync/`, which described the old vendored mirror and lost its subject when that mirror went. The `.dc.html` artboards in `design-system/` are hand-exported from Claude Design; when a design file has no local copy, record its numbers in a spec here and ask for the export — never reconstruct one from a transcript. |
| `.claude/commands/` | Custom slash commands, `<name>.md` | [`cpack`](.claude/commands/cpack.md) persists session knowledge into the docs below; [`cpush`](.claude/commands/cpush.md) commits and tags. Both are auto-discovered by Claude Code; no registration step. |
| `summary.md` | External code audit, 8 Sept 2026 | Read-only record of one review, with file:line evidence for every claim. Its open work is tracked as `backlog/017`–`backlog/025`; the backlog is where that work lives, not here. |
| `Worlflow.md` | The handoff diagram | Filename typo is known — see `backlog/011`. |

This page is the only index — no folder carries its own `README.md`. The root
`README.md` is a symlink to this file, so GitHub renders it; never write to it
directly.

### Precedence

**Where the built code and the written spec disagree, the code wins and the doc
gets corrected.** This already happened once: the spec called for a forest-green
accent with Space Grotesk + Inter; the built system uses deep indigo with Public
Sans. Docs 03 and 04 were rewritten to match. The 96 verified design-system files
were not touched. See `backlog/002`.

### Rules that bite

- **`design-system/` is read-only.** It is a byte-verified mirror. Editing it
  silently forks you from the Claude Design project.
- **Import components from `src/components/index.js` only**, and **no raw hex, no
  hardcoded px** — style with `var(--*)` tokens. **Both rules are conventions
  that nothing enforces, and were folklore before `_adherence.oxlintrc.json` was
  deleted.** `apps/web` has no `lint` script, CI runs `npm run lint --if-present`
  and so skips it silently, and oxlint 1.81 refused to load that config at all
  (`unknown field \`x-omelette\``). Even had it loaded, its rules match JS/JSX
  string literals, so **CSS was never linted** — a raw hex in `app.css` has
  always been review-only. `Skill/1 Build.md` carries the greps that approximate
  it; run them, because nothing else will.
- **Colour never carries meaning alone** — every status pairs a tone with a word.
- Regenerate the barrel from `_ds_manifest.json`; never hand-edit it.
- **Terraform selects a workspace; it never runs in `default`.** Environments are
  workspaces (`dev`, `prod`) sharing one `agentdisk-tfstate` bucket, not separate
  directories. A `terraform_data` precondition hard-fails any other workspace, and
  CI re-asserts `terraform workspace show` after selecting and before applying —
  because workspace selection is mutable CLI state and a stale selection is the one
  way this layout can apply dev intent to prod resources.
- **Terraform >= 1.11 is mandatory, not a preference.** Native S3-backend locking
  (`use_lockfile`) is the only locking that works against R2, and it went GA in 1.11.
  On 1.6.x the backend silently runs with *no* locking at all.
- **Terraform state is a secret store now — treat it as one.** The original rule
  was "no secret ever enters Terraform"; it was amended deliberately to remove
  every manual dashboard step from provisioning. The stack creates a Turnstile
  widget and an R2 signing token, and `sensitive` only masks a value in CLI
  output — state is unencrypted JSON, so `agentdisk-tfstate` holds a live R2
  read/write credential for the files bucket. **That makes the state bucket's
  own credentials the most powerful secrets in the system.** Never
  `terraform state pull` to a laptop or into a CI artifact; a state backup is a
  credential backup. `terraform output -json` includes sensitive values in full,
  so CI deletes that file the moment it is done with it.
- **`DATABASE_ENCRYPTION_KEY` and `SESSION_SIGNING_KEY` still never touch
  Terraform.** They decrypt stored data and sign sessions; they stay GitHub
  Environment secrets, pushed with `wrangler secret put`. The amendment above
  is one specific exception, not a general licence.
- **The deploy token can mint API tokens.** Creating the R2 signing token needs
  Account → API Tokens: Edit on `TERRAFORM_CF_ACCESS_TOKEN`, and Cloudflare does
  not restrict a token to minting only what it already holds. A leak of that
  token is therefore full account compromise, not just the resources it manages.
- **Resource IDs are never typed by hand.** CI injects them into `wrangler.toml`
  from `terraform output -json`; the committed file holds `TF_OUTPUT_*` placeholders.
- **Only `infra.yml` runs `terraform apply`.** The backend and frontend
  pipelines `init` and read `terraform output`, which takes no state lock and
  changes nothing. All three used to apply, because each needed outputs and
  applying first looked like the safe way to make them current — so every push
  had three appliers contending for one lock, and a registry 504 fetching the
  Cloudflare provider could fail a CSS change. Reading never needed the apply.
  **The cost is a race:** a push touching both `infra/terraform` and an app runs
  the two pipelines in parallel, so the app may read pre-apply outputs. Every
  name read is asserted against the environment's variables, so the dangerous
  version fails loudly; for the benign version, re-run the app pipeline, or use
  `deploy-all-dev.yml`, which orders them.
- **Branch protection requires two checks by their display name** — `App (lint,
  typecheck, test, build)` and `Terraform (fmt, validate)`. Renaming either job's
  `name:` without updating the rule leaves every PR waiting on a check that will
  never report. The dashboard and console jobs in `ci.yml` are deliberately not
  required yet.
- **A Worker that owns static assets needs `assets` and `keep_assets` in
  `ignore_changes`,** not just the code attributes. Without them a routine plan
  proposes stripping the deployed site's own files.
- **The dashboard's security headers live in `dist/_headers`, and nothing else
  fails if they stop being emitted.** `apps/web` is assets-only — no `main`, so
  there is no request-path code to set them — and the file is written at build
  time by a Vite plugin. If that plugin stops running, the build succeeds, the
  deploy succeeds, the tests pass, and every header silently disappears; the
  smoke test's header section is the only thing that turns that into a red
  pipeline. Generate the file from `scripts/security-headers.js` rather than
  writing headers anywhere else, and see 06 PART 16.9a for why COOP is absent
  and `style-src` still allows `'unsafe-inline'`.
- **Every authentication failure returns one identical body.** Unknown, revoked,
  expired, forged and disabled-agent credentials must stay indistinguishable to
  the caller — a distinguishable failure is an oracle telling an attacker which
  of their guesses is a real key. The reason goes to the log, never the client.
  **An absent credential is one of those failures, not a missing route.**
  `withAuth` gets this right for every route that goes through it; the trap is
  the handful that do not. `/v1/workspaces` is hand-routed because one path
  serves two callers — the anonymous Turnstile sandbox on POST, and a signed-in
  person on GET — and its hand-written branch answered "no token" with 404 "No
  such route.", which is the one thing that rules out the actual cause. Only
  `POST` with no credential at all is public there. `test/auth.test.ts` sweeps
  41 authenticated routes for this; a route added outside `withAuth` belongs in
  that table.
- **Scope prefixes match whole segments.** `/agents/bot` must not authorize
  `/agents/bot-evil/secrets.txt`; a plain `startsWith` says it does.
- **R2 bindings cannot presign.** `R2Bucket` is get/put/head/list. Presigned
  URLs go through R2's S3 endpoint with SigV4 and need a key pair the binding
  does not carry.
- **The R2 credential pair decides whether presigning is on — not the count of
  set variables.** CI injects `R2_ACCOUNT_ID` and `R2_BUCKET_NAME` from
  `terraform output` on every deploy, so they are always present. Treating them
  as evidence of intent made the ordinary no-signing deployment look
  half-configured, and because the config is read on the request path it turned
  that into a 500 on *every* route. Reading is also deferred to the routes that
  presign, so one broken variable cannot take down `whoami`.
- **A handler never gets a raw `R2Bucket`, for the same reason it never gets a
  raw D1 binding.** One binding reaches every tenant's bytes.
  `WorkspaceScopedStorage` binds the workspace in its constructor and takes file
  IDs, so there is no argument through which to name another tenant's object.
- **Sizes come from R2, never from the client.** The declared size buys a quota
  decision up front; `complete` asks R2 what it actually holds and re-checks.
  An upload over the cap is deleted and the row marked failed, rather than left
  orphaned in the bucket consuming storage nothing accounts for.
- **Folder emptiness is decided by path, never by `folder_id`.** Folders are
  created lazily, so a file can sit inside one with `folder_id` still NULL.
  Asking the `folder_id` question calls that folder empty and orphans live
  files.
- **Move and copy check both ends.** Write on a source must not buy write on a
  destination, or a scoped key can write anywhere by moving a file it controls;
  copy needs read on the source, or it becomes a way to pull any file into your
  own scope and read it there.
- **The console has one role, and the gate it removed is still in the source.**
  `support` and `admin` and `super_admin` collapsed to `admin` alone, so
  **everybody who can reach the console can do everything in it** — delete a
  workspace, edit the plan catalogue, grant console access to a new address.
  The only boundary left is being in `admin_users` at all. `requireRole`, the
  `RANK` map and the `admin.denied` audit path are deliberately still there and
  cannot fire: restoring a tier is adding a member to `ADMIN_ROLES` and a number
  to `RANK`, not re-deriving which of forty methods should have been gated.
  `admin-plans.test.ts` asserts that no `admin.denied` row is ever written, so
  the day a tier comes back that test failing is the reminder the denial path is
  live again. The tests that used to pin the matrix were rewritten rather than
  deleted — they now record the collapse instead of a permission model.
- **A admin account is an email address in a table, not a credential.** Migration
  `0014_admin_firebase_sso.sql` reversed 0008 on the owner's call: admin sign in
  through Firebase like everybody else, and `admin_users` decides who is an
  admin. `password_hash`, `totp_secret` and `admin_sessions` are gone, along with
  `scripts/provision-admin.mjs`, `src/admin/crypto.ts` and
  `test/admin-crypto.test.ts` — **an earlier version of this file described all
  three as the provisioning path; they no longer exist.** The first administrator
  is seeded by that migration, because under this scheme there is no credential
  to mint and so nothing for a provisioning step to do. `apps/admin`'s login is
  one Google button and nothing else. The property traded away is stated in the
  migration's header and is worth reading before touching admin auth: one
  Firebase token now reaches both the customer and the admin surface, and the
  `admin_users` lookup is the only thing separating them. That is why the role
  lives in the row and never in a Firebase custom claim — a claim is minted once
  and goes stale in a token already issued, a row is read fresh every request and
  a disable takes effect immediately. **Creating one is `POST
  /v1/admin/accounts`** — any console operator, audited as `admin.create`, and it
  shows nothing once because nothing secret is made. The pre-SSO
  `POST /v1/admin/users` is gone: it answered 501 to avoid minting a credential,
  which stopped being a risk when there was no credential, and its message
  instructed the caller to write a `password_hash` and a `totp_secret` into
  dropped columns. `admin.test.ts` pins its absence at 404, and the rule it used
  to carry — that an admin cannot create admin — moved to `admin-console.test.ts`
  against the surviving route. **The rest of `/v1/admin/users` is customer-user
  administration and is untouched**; the two are different things sharing a
  prefix, which is how the dead route stayed hidden.
- **One overlay ladder, and a dialog always outranks a drawer.**
  `docs/ui-layering.md` owns the scale; `app.css` defines it as `--z-*` tokens.
  The drawer was `80` and the modal scrim `60`, so a confirmation opened from
  the file drawer painted *underneath* it and its confirm button could not be
  clicked. The two swap — nothing sits at 61–79, so the exchange disturbs no
  third layer. **The whole change lives in the local `app.css`**, because
  `main.jsx` imports `styles.css` first and the local sheet wins; the vendored
  sheet is untouched. And a `z-index` only ranks siblings within the nearest
  stacking context — `.wsx__menu` sits inside `.shell__top`, so its number is
  capped by that ancestor and raising it does nothing. Modals must stay
  *siblings* of the drawer, never children.
- **A dialog moves focus once, when it opens.** `Modal` and `Drawer` had
  `onClose` in the dependency array of the effect that focuses a field. Every
  call site passes an inline arrow, and the parent re-renders on each keystroke
  because it owns the field's state, so the effect re-ran per character and
  re-focused the first focusable element in the dialog. That is the header's
  close button, so typing one character into any dialog in the product threw
  focus onto Close and the next character went nowhere. Handlers that only need
  to be *current* belong in a ref, never in a dependency array. And 'first
  focusable' is the wrong target regardless: it opens every dialog with
  'dismiss' selected.
- **Clear inbound foreign keys before deleting a subtree.** Within one statement
  SQLite deletes rows in arbitrary order and checks foreign keys immediately, so
  a self-referencing tree (`folders.parent_folder_id`) or one referenced from
  outside (`files.folder_id`) fails whichever way the DELETE is ordered.
- **Destroying a workspace is a person's act, never a credential's.** `DELETE
  /v1/workspaces/:id` refuses an API key outright, requires the *account* owner
  rather than a workspace admin, requires the workspace's name in the request
  body — so the confirmation belongs to the operation and not to one client —
  and refuses the caller's last workspace, because an account with none lands on
  a screen written for somebody whose invitation was revoked. R2 objects go
  before the D1 rows, matching the purge job: the rows are the only record of
  which objects exist, so losing them first orphans bytes nothing can find.
- **A workspace slug is an address; the `ws_...` ID is still the identifier.**
  Dashboard URLs are `/w/{slug}`, and two invariants keep that from becoming a
  second identity. **A slug can never look like an ID:** `slugify` lowercases and
  turns every non-alphanumeric into `-`, so no slug can hold an underscore, and a
  workspace literally named `ws_ABC` slugs to `ws-abc` — which is why resolving a
  URL segment needs no lookup to know what kind of thing it is. **A slug never
  changes:** it is derived once at creation and a rename leaves it alone, because
  the UI has always promised that renaming breaks no URL. Raw-ID URLs still
  resolve and redirect to the slug, carrying path, query and fragment across. The
  ID stays on screen everywhere it is genuinely needed — `Dashboard.jsx`'s ID chip
  read the URL param, which was the ID until slugs existed and would silently have
  started showing the slug; that chip is the value people paste into an API call.
  **And a `/w/{segment}` that resolves to nothing renders the 404.** It used to
  render the shell anyway: the breadcrumb fell back to the literal word
  "Workspace" and every screen inside took its workspace from the *context*
  rather than the URL, so a bogus ID quietly showed you your own default
  workspace's files under an address that named someone else's. One check covers
  both "no such workspace" and "not a member", because `workspaces` is the
  membership-scoped list the API returned — and answering the two identically is
  what stops the URL confirming that another account's workspace exists.
- **Migration 0009 deliberately slugifies less than `lib/slug.ts` does.** It
  backfills every row to its own ID first — guaranteed unique, guaranteed
  URL-safe, cannot fail on data it has never seen — then upgrades only names made
  of ASCII letters, digits, spaces and dashes whose slug collides with nothing.
  Approximating NFKD normalisation and diacritic-stripping in nested `replace()`
  calls would be a second, subtly different definition of the same function, and
  the one that runs exactly once on data nobody re-reads afterwards. Uniqueness is
  per organization (`idx_workspaces_org_slug`), not global; the index is the
  guarantee and `uniqueWorkspaceSlug` is only advice, so `createWorkspaceForUser`
  retries a UNIQUE violation rather than pretending the read settled the race.
- **A screen must compute permissions from the real credential, never from a
  fixture.** The MCP page listed every write tool as available to a key scoped
  `read, list`. The backend was never fooled — `tools/list` filters on scope and
  `tools/call` re-asserts it — but a screen that contradicts the scope model
  teaches people to distrust the thing protecting them. Tool availability now
  comes from the connecting key's own `scopes.ops`, and the badges say `read` /
  `write` / `delete` / `list`, which is the vocabulary the API and the Create-key
  modal both use. The `files:*` spelling exists only in the design-system's
  `mcpTools` fixture and matches nothing in this product.
- **An unclaimed sandbox is a claim state, never a plan.** `SANDBOX_LIMITS`
  exists in `lib/plans.ts` but is deliberately absent from `PLAN_NAMES`, because
  that union gates `organizations.plan_override` and `organizations.plan` — the
  columns a human can set. "sandbox" is derived fresh from `claimed_at` on every
  request; making it selectable would let somebody be *placed* on it, and the
  unclaimed sweep would then become eligible to delete their workspace.
- **The sandbox limit is gated on the claim token, not just on `claimed_at`.**
  `isSandboxWorkspace` requires `claimed_at IS NULL` **and**
  `claim_token_hash IS NOT NULL`, and the second half is the rollout guard rather
  than a redundant check: only workspaces provisioned after claiming shipped were
  ever issued a token, so the tighter allowance cannot apply retroactively to the
  weeks of unclaimed sandboxes already sitting in dev — any of them over 50 MB
  would otherwise have started failing *every* write the instant it deployed. It
  needs no cutoff timestamp to configure, get wrong, or forget to move between
  environments.
- **A claim link is a bearer secret equal to "own this workspace", so only its
  SHA-256 is stored.** That has a consequence the design brief did not anticipate:
  the sandbox quota warning cannot carry the tokenised `claimUrl` it asks for,
  because a token rebuildable on an arbitrary request is a token kept in
  cleartext. The tokenised link exists only in the provisioning response; the
  warning carries the untokenised claim page and the workspace ID. See
  `lib/claim.ts`'s header.
- **API keys are kept, sealed, and only a signed-in owner can open one.**
  Until migration 0022 a key existed nowhere after creation — only its hash —
  and "you won't see it again" was the whole of the protection. On the owner's
  call (22 Sept 2026) the token is now stored in `api_keys.key_ciphertext`,
  AES-256-GCM under `DATABASE_ENCRYPTION_KEY` and bound to the row id
  (`lib/secretbox.ts`), so a copy of the database is not a copy of the keys
  and a ciphertext moved between rows opens as nothing. `GET
  /v1/keys/:id/secret` is the only reader: it refuses an API key (a credential
  that can read other credentials can escalate), refuses a reader (who could
  otherwise copy a writer), refuses a revoked key, answers 409 for a key minted
  before it was kept, and audits every success as `key.revealed`.
  **Authentication is still by `key_hash`** — the ciphertext is never on the
  request path. The dashboard's eye button and the MCP page's key dropdown
  both go through this route; the sandbox key an agent provisions is sealed
  the same way, so it becomes viewable to whoever claims the workspace.
- **Nothing auto-renews, and checkout creates a `payment` rather than a
  `subscription`.** Owner's decision, 23 September 2026, against the industry
  norm and against the amardrive reference — whose own notes say an earlier
  no-auto-renewal design "was replaced in June 2026 and should not be
  reproposed". It was raised, reaffirmed, and is settled. A purchase buys one
  month; `lib/renewal.ts` owns the clock and `jobs/billing-renewal.ts` walks it:
  remind at day −7, `expired` and write-locked at day 0, `purge_after` stamped at
  day +7. **The reason it is `mode: "payment"` and not a subscription with
  `cancel_at_period_end` is the failure mode**, not taste: one unapplied flag and
  the customer is charged again without consent, which is the single outcome
  being ruled out. A one-off payment cannot do that — Stripe holds no mandate.
  It also removes the early-renewal trap, since a live subscription would make
  the day −7 email point at a button that 409s. The cost is that
  `customer.subscription.*` and both `invoice.*` handlers are now dormant: they
  are kept, subscribed and working, because a subscription made by hand in the
  Stripe dashboard still arrives, and because deleting them makes returning to
  auto-renewal a rewrite instead of a decision. **`past_due` is therefore no
  longer reachable through checkout** — a one-off payment has no invoice to fail.
- **A renewal clears `purge_after`, and that write is the feature.** Somebody who
  pays on day ten must not be deleted by a sweep that stamped them on day seven.
  It is the one assertion in `billing.test.ts` worth protecting above the others.
  The ladder also **defaults to reporting** (`BILLING_EXPIRY_ENABLED`), like the
  sandbox sweep and the admin purge, and **expiry deliberately leaves
  `organizations.plan` on the paid tier** — dropping a 40 GB account to Free's
  1 GB puts it instantly over quota through no act of its own, during the exact
  window we are asking it to renew in.
- **All mail is Cloudflare Email Service, and it goes through `lib/email.ts`.**
  The Worker uses the `EMAIL` `send_email` binding — no secret, nothing for CI
  to push — and Firebase uses the same service over SMTP, so the two share one
  quota. Any sender on `@agentdisk.io` is deliverable and nothing else is. In
  tests, spy on `env.EMAIL` or pass a fake binding; never stub `fetch`. Mailjet
  is gone everywhere. See [Skill/2 Email](Skill/2%20Email.md).
- **State changes and lifecycle emails are separate passes.** Doing both in one
  loop means a failed send leaves the state already changed, so the row stops
  matching and the message is never retried — the customer is locked out with no
  explanation. Inverting it is worse: an email outage would stop accounts
  expiring at all, which is a billing failure that quietly grants free service.
  So a state pass selects on state and always succeeds, and a notification pass
  selects on state *and* the absence of a `notifications_sent` row. **The UNIQUE
  index is the send-once guard**, not application logic — the cron is hourly, and
  a guard written as an `if` is one refactor away from 168 copies of "your data is
  scheduled for deletion". The row is claimed *after* a successful send.
- **Discounts live in Stripe; there is no promo table.** Stripe counts
  redemptions atomically at the moment a payment clears, so two people racing for
  the last use of a code cannot both win — a local mirror would have to reproduce
  that from a database that is not on the payment path. The console
  (`admin/promos-access.ts`) creates a Coupon then a Promotion Code, and
  deactivates rather than deletes, because discounts already taken stay on real
  invoices. **One-time versus unlimited is `max_redemptions`**: absent means no
  limit, `1` means single use, and the form says which in words — an empty box
  standing for "unlimited" is the `NULL`-versus-`-1` ambiguity again, and here the
  wrong reading gives away unlimited discounts. Customers redeem on Stripe's own
  page via `allow_promotion_codes`; **validating a code on our side would mean
  passing `discounts` instead, which Stripe refuses to accept alongside it.**
- **Storage and file quota belong to the billing account, not the workspace.**
  The subscription is sold to an organization: one card, one plan, many
  workspaces. Until migration 0017 `assertWithinQuota` compared a single
  workspace's counters against that account-level plan, so an account on Pro
  holding five workspaces held five times the Pro allowance — and the way to
  buy more room was to press "New workspace", which is free. Membership being
  per workspace is what made it easy to miss: the two are scoped differently on
  purpose and only the *quota* was on the wrong side of the line.
  `organizations.storage_bytes_used` / `file_count` are the numbers enforced;
  the workspace copies survive because a person looking at one workspace wants
  to know what it holds. **Egress and requests stay per workspace**, because
  they are period counters resetting on the workspace's own `period_reset_at`
  and there is no account-level period to reset them on. **`plan_override` moved
  up too, in migration 0018** — leaving it on the workspace kept the ceiling
  per-workspace while the usage it was measured against was pooled, so the same
  bytes were checked against Basic through one workspace and Free through its
  sibling, and which limit applied depended on where the write came in. It is
  `organizations.plan_override` now, the column is gone from `workspaces`, and
  the console's quota bump is addressed by workspace but applied to the whole
  account — the dialog says so, because it previously said the opposite.
  The type is the guard: `assertWithinQuota` takes `WorkspaceRow &
  AccountUsage`, so a caller holding only a workspace row cannot call it at
  all. **Every surface that divides usage by a plan limit had to move with it**
  — `whoami`'s `usage` (the dashboard reads it, so `backlog/017` would
  otherwise have recurred exactly), and the admin console's
  `workspaces/needs-attention`, which was flagging at 95% of an allowance the
  workspace no longer had.
- **The hard quota block and the soft sandbox warning are one call.** Every write
  path calls `assertQuotaAndWarn`, never `assertWithinQuota` directly, so there
  is no way to perform the block without also computing the warning — from the
  same row, the same limits and the same demand. `backlog/017` is why: this
  product already shipped an 80%/95% warning that lived only in the dashboard's
  arithmetic, was never wired to the request path, and lied. Note that **no route
  declares `requirement.demand`**, so the middleware cannot compute this before
  the handler runs; the warning is set on the context by the handler and
  serialized onto the response once, centrally, by `withAuth`.
- **The unclaimed sweep defaults to reporting, not deleting.**
  `expireUnclaimedWorkspaces` takes `dryRun` and defaults it to `true`; only
  `SANDBOX_EXPIRY_ENABLED = "true"` turns on real deletion. Dev holds weeks of
  expired-by-definition sandboxes, and the delete is a cascade with no undo, so a
  delete-by-default deploy would empty the environment on its first cron tick.
  See `backlog/030`.
- **One sanctioned cross-tenant storage operation exists, and its signature is
  the safety property.** `transferObject(source, id, destination, id)` takes two
  already-bound `WorkspaceScopedStorage` instances and **no workspace ID**, so a
  caller can only reach across a boundary it has already legitimately opened both
  sides of. The merge needed two tenants; the alternative was relaxing the
  constructor binding for every other caller in the product to serve one.
- **Copy before delete when relocating; delete before row when discarding.** The
  claim merge writes the destination object *and* row before removing the source,
  which is the opposite of `jobs/purge.ts`. Deliberate: purge is discarding data,
  where a briefly-orphaned object is harmless, while a merge is relocating it,
  where the destination must exist before the source stops existing.
- **A merge is all-or-nothing.** The whole sandbox is checked against the target's
  quota before a byte moves. Merging whatever fits and reporting success would be
  a `backlog/023` false success, and a uniquely bad one — the files it dropped
  were about to be deleted from the only other place they existed.
- **`ConfirmModal` defaults `destructive` to true.** A red dialog with an alert
  mark is right for deleting a workspace and wrong for an additive act like
  claiming one; pass `destructive={false}` there. Dressing additive actions in the
  danger treatment is how people learn to click through the red dialogs that
  matter.
- **Admin audit discipline is inherited, never repeated.** `AuditedAdminAccess`
  holds `record`, `recordFleet` and `requireRole` as protected members and every
  admin area class extends it, so no area can perform an action without the
  machinery that writes it down. The class was split out of `AdminScopedAccess`
  when the console grew six areas: one class holding all of them would have run
  past a thousand lines, which is the point at which nobody reads the audit
  methods again to check they are still unconditional. **A refusal is recorded
  too** — `requireRole` writes a `admin.denied` row before throwing, because a
  log of only successful actions cannot show somebody repeatedly attempting what
  their role forbids.
- **A deleted account is our own fact, checked before Firebase's.** Disabling a
  Firebase identity does not invalidate an ID token already issued; it stays
  valid for up to its remaining hour. So `users.deleted_at` and
  `users.disabled_at` are refused in `resolveVerifiedUser`, beside the
  `session_revoked_after` check and before any membership lookup — otherwise
  deletion would depend on a third party's side effect having succeeded, and a
  failed `disableUser` would leave a live identity refreshing tokens while the
  database said the account was gone. **Unlike revocation, a later `iat` is not
  a way back in**, which is why this needed its own column.
- **The password policy is enforced in the Firebase console, and `lib/password.js`
  is only its echo.** Nothing in this repository ever receives a password, so
  nothing in this repository can enforce one: sign-up, reset and change all hand
  it to Firebase, and a caller holding the public web API key reaches
  `identitytoolkit`'s `accounts:signUp` without loading our bundle at all. The
  rules live at Authentication → Settings → Password policy on **Require
  enforcement** — currently **8 characters, an uppercase, a lowercase, a number
  and a special character** — and `apps/web/src/lib/password.js` restates them so
  a person is told the rules while typing instead of after a round-trip. **Change
  one and you must change the other**, in a console nothing in CI can read. Two
  things soften that: `auth/password-does-not-meet-requirements` is handled in
  `describeAuthError`, so a tightened console still produces a message somebody
  can act on; and the SDK's `validatePassword`, which would fetch the live policy
  and make drift impossible, was considered and rejected — a network round-trip
  on a field being typed into, failing awkwardly offline. **`forceUpgradeOnSignin`
  is off**, so existing accounts are untouched until they next set a password;
  the policy applies to every *set*, including reset and change, so login must
  never gate on it or it would lock out the accounts the flag exists to spare.
  All three forms call `checkPassword`, because the defect being fixed was three
  screens disagreeing: signup and reset tested length only, Settings tested
  nothing while promising twelve characters, and a strength meter scored by a
  private fourth rule and let through whatever it concluded.
- **Admin deletion sets a timestamp and stops.** Both delete endpoints are soft
  with a 30-day window; the cascade belongs to `purgeAdminDeleted`, which
  **defaults to reporting** and needs `ADMIN_PURGE_ENABLED = "true"` to delete
  anything — the same shape as the sandbox sweep, for the same reason. A
  workspace must already be *suspended* before it can be deleted: suspension is
  instant and reversible, so it is the right first move in every scenario ending
  in deletion, and it gives the customer a chance to notice. A user row is
  scrubbed, never removed — it is what an `audit_events` actor id resolves to.
- **The plan catalogue has exactly one writer: the admin console.** The four
  products were created once in Stripe (18 Sept 2026) and
  `infra/stripe-catalogue/` was deleted the same day. That was not tidying:
  Terraform held no state for those products, so an apply would have created a
  SECOND set of four carrying the same `package_id`s, and the sync takes
  whichever was written last. Production is populated by hand from the Stripe
  dashboard, deliberately — one declaration, edited in one place, no pipeline to
  keep in step.
- **A product is ours only if its `package_id` starts with `agentdisk-`.** The
  Stripe account is shared with another product line, and the earlier rule
  accepted any `package_id` at all — so a sync would have written
  `amardrive-pro` into this product's entitlement table. Presence is not
  ownership, and `plan_id` cannot be used to claim a product that failed the
  prefix test.
- **A admin plan edit writes Stripe first and D1 second.** If the push throws,
  the local row is never touched. A local-only save produces a pricing table
  that says one thing while Stripe charges another, and nothing surfaces the
  disagreement until somebody is billed wrongly. The residual risk runs the
  other way and is already covered twice, by the `product.updated` webhook our
  own push triggers and by the on-demand sync. **Pulling from Stripe is always a
  diff the operator confirms field by field** — a one-click pull can bill real
  customers the wrong amount, and `id`, `package_id` and `stripe_product_id` are
  unsyncable because they are identity, not content.
- **`metadataForPlan` lives beside the decoder it must round-trip with.**
  Separating the two directions of one translation is how they drift, and the
  drift would show as an edit that appears to work and then quietly changes the
  entitlement it just set, via the webhook it triggered.
- **Literal route segments are matched before `:id` patterns.**
  `workspaces/needs-attention` was swallowed by the `:id` GET above it and
  answered 404, which reads like a data problem rather than the routing one it
  is. Same for `plans/stripe-diff` and `plans/sync-from-stripe`.
  `admin-console.test.ts` pins all three.
- **The console renders nothing it cannot source.** No regions, no card brand or
  last-4 (we are deliberately outside PCI scope), no overage row (pricing is
  hard-capped), no per-workspace MRR (billing is org-scoped, so that is the
  wrong unit rather than a missing field), and webhook delivery history says
  *not tracked yet* because nothing records delivery attempts. `null` and `-1`
  stay distinguishable on screen as well as in the database: one is a gap that
  defers to the `lib/plans.ts` floor, the other is a decision.
- **The role gate is checked twice and only the server's counts.** The console
  hides what a role cannot do; every admin method re-checks. Billing and Plans
  are **support-readable**, correcting the design — support is exactly who needs
  to see why a customer's writes are blocked.
- **Settings → Privacy is a summary of `routes/Legal.jsx`, which is the
  authoritative text.** The tab restated the policy instead of pointing at it,
  and went on describing a hashed password and Resend-sent password resets for
  months after Firebase took over sign-in, while `/privacy` itself was correct.
  Change both together, and Legal.jsx wins. Its own "reviewed by no lawyer"
  banner is still standing.

---

## Catalog

### Specification — [docs/design/](docs/design/)

| # | Document | Covers |
|---|---|---|
| 00 | [Index](docs/design/00-INDEX.md) | How the package fits together |
| 01 | [Research & opportunity](docs/design/01-research-and-opportunity.md) | Competitive landscape, 20 products, the gap |
| 02 | [Product & MVP scope](docs/design/02-product-and-mvp-scope.md) | Personas, entity model, MVP-0/1/V2, quotas |
| 03 | [UX architecture & screens](docs/design/03-ux-architecture-and-screens.md) | Design principles, design system, **all 32 screens** |
| 04 | [Claude Design prompt](docs/design/04-claude-design-prompt.md) | Binds to the built design system. No longer a "build this" prompt |
| 05 | [Technical architecture](docs/design/05-technical-architecture.md) | D1 schema, R2 keys, REST API, MCP tool spec |
| 06 | [Security, privacy, legal](docs/design/06-security-privacy-legal.md) | Auth, tenant isolation, control list, error catalogue |
| 07 | [Cloudflare deployment & cost](docs/design/07-cloudflare-deployment-and-cost.md) | Wrangler, environments, **§18.6 monorepo layout** |
| 08 | [Claude Code prompt](docs/design/08-claude-code-prompt.md) | Hands-off build prompt — start the backend with this |
| 09 | [Test strategy](docs/design/09-test-strategy-and-failure-modes.md) | 21 security test cases, failure modes, backup |
| 10 | [CI/CD, roadmap, ADRs](docs/design/10-cicd-docs-roadmap-and-recommendation.md) | Pipelines, 12-phase roadmap, 8 ADRs |
| 11 | [Backend implementation prompt](docs/design/11-backend-implementation-prompt.md) | Standalone backend-only build prompt |
| 12 | [Deployment roadmap · agentdisk.io](docs/design/12-deployment-roadmap-agentdisk-io.md) | The 29-step plan: naming, phases A–G, open decisions |
| 13 | [Infra & CI/CD prompt](docs/design/13-infra-cicd-implementation-prompt.md) | Executes doc 12 — Terraform, GitHub, Actions. Hands off to doc 11 |
| 14 | [Admin panel & billing](docs/design/14-admin-panel-and-billing-design.md) | PART 27–29 — admin console, Stripe billing, plan limits |
| 15 | [Frontend/admin/billing prompt](docs/design/15-frontend-admin-billing-implementation-prompt.md) | Standalone build prompt for doc 14 |
| 16 | [Firebase auth & launch prompt](docs/design/16-firebase-auth-and-final-launch-prompt.md) | PART 30 — the auth model in force. Read before touching sign-in |
| 17 | [Dev environment test findings](docs/design/17-dev-environment-live-test-findings.md) | 7 Sept 2026 live pass against `app-dev` |
| 18 | [Full UI audit & fix prompt](docs/design/18-full-ui-audit-and-fix-prompt.md) | 8–9 Sept 2026 audit, now **Parts 1–10**. Parts 1–6 are closed rounds whose outcomes live in docs 03/06 and the backlog; Parts 7–10 are later live passes and **still carry unresolved findings** — read §9.3–9.5 before assuming a screen works |
| 19 | [MCP public distribution guide](docs/design/19-mcp-public-distribution-guide.md) | How to publish the MCP server for public install: per-client snippets, the official registry, marketplaces. Named the doc-18 §9.4 path-scope question as a launch blocker; that blocker is cleared — see `backlog/029` |

### Design system — [design-system/](design-system/)

Claude Design project `agent-storage-mcp` · `d311bfd0-9751-4a9b-84f4-b33e7a09378e`

| Holds | Detail |
|---|---|
| 32 components | 9 primitives, 9 structure, 5 feedback, 1 developer, 8 AgentDisk-specific |
| 98 tokens | `styles.css` — colour, type, 4px space scale, radius, elevation, motion |
| 26 preview cards | `card.html` per component; these stay upstream, not vendored |
| Runtime bundle | `_ds_bundle.js` — 2083 lines, exposes `window.AgentStorageMcp_d311bf` |
| Lint contract | **Gone with the mirror.** The rules survive as the convention above and the greps in `Skill/1 Build.md`; no tool checks them. |

The AgentDisk-specific components carry the product thesis: `FileCell` (agent
provenance), `ApiKeyDisplay` (masked by default), `PermissionSelector` (least privilege),
`McpToolList` (per-tool scopes), `ActivityRow` (agent vs human actors).

### Skills — [Skill/](Skill/)

| # | Document | Covers |
|---|---|---|
| 1 | [Build](Skill/1%20Build.md) | Toolchain, run/build/test commands for both apps, the expected build baseline, barrel regeneration, adherence checks and their calibration, mutation testing, and how to read a failed pipeline run |
| 2 | [Email](Skill/2%20Email.md) | Cloudflare Email Service for both the Worker (`EMAIL` binding) and Firebase (SMTP): the shared quota, the `@agentdisk.io` sender rule, calling `sendEmail`, error codes and limits, the console's test send and compose, how to stub the binding in tests, and what to check when mail stops |

### Backlog — [backlog/](backlog/)

Three items. 002 is built on 001 and cannot be finished before it; 003 is
independent of both.

| # | Item | Status |
|---|---|---|
| 001 | [Billing module](backlog/001-billing-module.md) | **TOP** — 11 of 12 tasks shipped; the catalogue, checkout, the webhook, the plan editor, the pricing page, the Manage Subscription picker, the manual-renewal ladder and console promo codes are in. **Task 10, the agent/key/member/workspace count gates, is the one left — and nothing has touched real Stripe yet** |
| 002 | [Admin panel](backlog/002-admin-panel.md) | **HIGH** — built end to end, not yet proven against live dev. Start with the bootstrap pipeline; the plan editor is untestable until 001's catalogue is applied |
| 003 | [Google consent support email](backlog/003-google-consent-support-email.md) | **MEDIUM** — `firebase.json` shows the sibling product's address on the Google sign-in consent screen. One line, plus the `firebase deploy --only auth` trap |
**Items 001–031 were deleted on 18 September 2026**, deliberately, so that the
billing module is the whole backlog. They are recoverable in full from git at
the tag `pre-billing-module` — for example
`git show pre-billing-module:backlog/025-authorization-hardening.md`. Six of them
were open security or correctness work (025 authorization hardening, 019
rate-limiting the authenticated surface, 028 admin-console security headers, 021
audit-trail gaps, 022 webhook gaps, 018 abandoned uploads); they are not fixed,
merely no longer tracked here.

Source comments across `apps/` still cite those numbers — `backlog/017`,
`backlog/023`, `backlog/024` and others. Those citations stay accurate against
the tag, and the reasoning they point at is the reason the comment exists, so
they have been left alone rather than scrubbed.

---

## Status

**Dev is a working product.** A stranger can sign up with Google, GitHub or
email, land in a workspace made for them, create an agent, mint a scoped key,
upload files from the browser or the API, invite a colleague, connect an MCP
client, and open Stripe's billing portal. Every one of those was run against the
live deployment rather than inferred from the code — see
[docs/STATUS.md](docs/STATUS.md) for what was verified and how, and
[docs/USER_TESTING_GUIDE.md](docs/USER_TESTING_GUIDE.md) for the walkthrough a
person can follow.

```
apps/api    869 tests across 47 files · typecheck clean
apps/web    324 tests across 24 files · build clean
apps/admin   47 tests across 4 files · build clean · 108 KiB gzipped
Worker      226 KiB gzipped, against Cloudflare's 1 MB limit
```

**Roadmap step 27 is met**: a 2 MB file round-tripped through
`agentdisk-dev-files` via a presigned PUT and GET, SHA-256 identical in and out.

Live on three hostnames: `api-dev.agentdisk.io` (REST + MCP at `/mcp`),
`mcp-dev.agentdisk.io`, `app-dev.agentdisk.io`. The full loop runs unattended:
push to `dev` → verify → `terraform apply` → migrations → `wrangler deploy` →
smoke test. **Prod has never been applied** — the `prod` workspace is empty,
gated behind a PR into `main` plus required-reviewer approval.

### What exists

Human authentication is Firebase — Google, GitHub, email/password and email-link
— verified in the Worker with cached JWKS and Web Crypto, because the Admin SDK
is Node-only and does not run here. Agents are unaffected: they hold API keys and
never touch Firebase.

One billing account owns many workspaces; membership is **per workspace**, so
inviting somebody into one client's workspace does not hand them the one beside
it on the same bill. Roles are **owner / reader** — "admin" was the middle
role and is gone, because the word now means an operator of the internal
console and nothing else. The consequence is real and worth knowing before you
look for the missing role: **no invitable role can write.** Somebody invited
into a workspace reads it; writing belongs to the owner and to the API keys
they mint, which is where agent writes came from anyway.

The REST surface covers files (both upload paths, move, copy, soft delete,
restore), folders, search, agents, keys, members, webhooks, activity, billing,
and workspaces — including `DELETE /v1/workspaces/:id`, which destroys one and
everything in it.

**Agent-provisioned workspaces can now be claimed.** `POST /v1/workspaces`
returns a one-time claim link beside the one-time API key;
`GET /v1/workspaces/claim/:token` previews it with no credential at all, and
`POST` to the same path takes ownership — either keeping it as its own workspace
under the caller's billing account, or merging its files into a workspace they
already administer and deleting the sandbox. A merge repoints the agent's
*existing* key row rather than reissuing, so the agent's next call lands in the
new workspace with no re-authentication. Unclaimed workspaces are held to a
tighter `SANDBOX_LIMITS` allowance and are swept after 7 days — that sweep is
live but in log-only mode, see `backlog/030`.
The MCP server exposes ten tools at `/mcp` in the same Worker — each one calls
the REST handler that already does the work, so the two surfaces are literally
the same code and cannot drift in what they allow.

An hourly cron purges soft-deleted objects past their 24-hour grace period and
reconciles the usage counters against the rows.

### What is not built

- **Yearly billing.** Monthly only; `plans` holds one `stripe_price_id` and one
  `interval` per plan, so adding it is a migration plus a catalogue-sync change,
  not a toggle.
- **Mid-period plan changes**, and any proration with them. Checkout refuses
  while a period is comfortably live and opens in the last seven days; switching
  plans takes effect from the next period.
- **Customer-side promo validation.** Codes are typed on Stripe's page. See the
  `allow_promotion_codes` rule above for why the two cannot both exist.
- **Stripe Tax.** No `automatic_tax`, no `tax_behavior`, no billing-address
  collection. Cheapest to turn on before the first non-US sale, which has not
  happened.
- **Multipart upload** and **signed permanent links**.
- **Full-text search inside files.** Search covers names, paths, captions and
  tags, and the response names the fields it looked at.
- **`openapi.yaml`**, and the generated docs site.
- **Production.**

A second category, found by the 8 Sept 2026 audit ([summary.md](summary.md)):
things that *appear* built and are not connected. Several declared limits are
never enforced and a set of dashboard controls report success for work that
never happened. The isolation and authentication core is sound; the wiring
around it is not finished. See `backlog/017`–`backlog/025`.

**The billing write block is no longer one of them.** `assertBillingAllowsWrite`
is on every write path, and `expired` — not `past_due` — is the state this
product now actually reaches. **The count gates still are**: `PLAN_LIMITS.agents`,
`.apiKeys`, `.members` and `.workspaces` are read by nothing on a write path, so
only `shareLinks` is enforced (`routes/shares.ts`). That is `backlog/001` task 10.

### Faults found only by running it

`wrangler deploy` refuses a declared queue consumer when the Worker exports no
`queue` handler; Wrangler silently enables `workers.dev`, publishing a second
public hostname that bypasses the custom domains; `cloudflare_d1_database` sends
`read_replication: null` on update, so apply succeeds once and fails every run
after; `cloudflare_turnstile_widget` returns its `domains` list sorted, so
declaring it in another order made every plan round-trip the widget's secret; a
Worker owning static assets needs `assets`/`keep_assets` in `ignore_changes` or a
routine plan proposes deleting the deployed site; and `firebase deploy --only
auth` silently resets `passwordRequired`, turning email-link sign-in off on every
run. All are fixed and commented where they bite.

Two more cost real time and are worth recognising on sight, both recorded in
[Skill/1 Build](Skill/1%20Build.md): an R2 `AccessDenied` means the credential is
valid and its *permissions* moved, not that the secret is wrong; and
`Credential access key has length 64, should be 32` means an Access Key ID field
holds a Secret Access Key.

Every security-critical behaviour in the storage core was mutation-tested: 22
deliberate breaks across two rounds, each confirmed to turn the suite red.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
