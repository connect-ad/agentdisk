# AgentDisk

Serverless file storage built for AI agents. Files, folders and metadata over
REST and MCP — scoped credentials, hard-capped pricing, no servers to run.

---

## Information Route

Where each kind of knowledge lives. Read this before executing any development
task.

| Path | Holds | Rule |
|---|---|---|
| `CLAUDE.md` | This route and the catalog | Source of truth for *where things are*. Not a duplicate of the specs. |
| `docs/design/` | The specification, `NN-<slug>.md` | 20 documents, PART 1–30. The product's design authority — but see the precedence rule below. |
| `design-system/` | Upstream mirror of the Claude Design project | **Read-only.** Byte-identical to the remote (96/96). Changes go into Claude Design, then re-import — never edit here. |
| `apps/api/` | The Cloudflare Worker: REST + MCP, one deployable | Both surfaces are built and share one authorization chain. MCP tools call the REST handlers rather than reimplementing them, so the two cannot drift — a claim live testing disputes for `pathPrefix`; unresolved, see [029](backlog/029-mcp-path-scope-contradiction.md). |
| `infra/terraform/` | All infrastructure as code | One root config, one module, **one workspace per environment** (`dev`, `prod`). No `environments/` directories — see the workspace note below. |
| `.github/workflows/` | CI and deployment pipelines | **Three areas, split by what they own: `infra`, `backend`, `frontend`.** Each is one reusable engine plus thin per-environment callers, so prod can never drift from dev. Path filters mean an `apps/web` push moves nothing else. `frontend.yml` is called once per app (dashboard, console). `ci.yml` gates PRs and covers all three apps. `deploy-all-dev.yml` is the ordered manual full deploy. |
| `apps/admin/` | The internal staff console, at `admin-dev.agentdisk.io` | Its own origin on purpose: 14 PART 27.2 scopes the staff session cookie to it, so a staff and a customer credential cannot reach each other in a browser. Deliberately does not import `design-system/` — looking different from the customer dashboard is how a support engineer knows which one they are in. |
| `apps/web/` | The dashboard SPA, live at `app-dev.agentdisk.io` | `src/components/` is vendored from `design-system/`; `src/components/index.js` is generated. Hand-written code lives in `src/routes/` and `src/components-local/`. `src/components/AppShell.jsx` is the one vendored file that deliberately diverges from the mirror, for three reasons awaiting the same upstream trip — [015](backlog/015-rename-in-design-system.md), [016](backlog/016-upstream-workspace-switcher.md) and [026](backlog/026-upstream-account-menu.md). Deployed as a Workers static-assets Worker, not Pages — see [013](backlog/013-deploy-dashboard.md). |
| `Skill/` | Reusable how-to knowledge, `<N> <Name>.md` | Procedures, commands and their calibration. Not the specification — that is `docs/design/`. |
| `backlog/` | Outstanding tasks, `NNN-<slug>.md` | Status lives in the file; a finished item stays as a record. |
| `.design-sync/` | Sync state and hard-won process notes | `config.json` pins the Claude Design project. `NOTES.md` holds gotchas that cost real time — read it before any file transfer. |
| `.claude/commands/` | Custom slash commands, `<name>.md` | [`cpack`](.claude/commands/cpack.md) persists session knowledge into the docs below; [`cpush`](.claude/commands/cpush.md) commits and tags. Both are auto-discovered by Claude Code; no registration step. |
| `summary.md` | External code audit, 8 Sept 2026 | Read-only record of one review, with file:line evidence for every claim. Its open work is tracked as [017](backlog/017-enforce-declared-limits.md)–[025](backlog/025-authorization-hardening.md); the backlog is where that work lives, not here. |
| `Worlflow.md` | The handoff diagram | Filename typo is known — see [011](backlog/011-rename-workflow-file.md). |

This page is the only index — no folder carries its own `README.md`. The root
`README.md` is a symlink to this file, so GitHub renders it; never write to it
directly.

### Precedence

**Where the built code and the written spec disagree, the code wins and the doc
gets corrected.** This already happened once: the spec called for a forest-green
accent with Space Grotesk + Inter; the built system uses deep indigo with Public
Sans. Docs 03 and 04 were rewritten to match. The 96 verified design-system files
were not touched. See [002](backlog/002-reconcile-brand-drift.md).

### Rules that bite

- **`design-system/` is read-only.** It is a byte-verified mirror. Editing it
  silently forks you from the Claude Design project.
- **Import components from `src/components/index.js` only.**
  `_adherence.oxlintrc.json` forbids reaching into component internals.
- **No raw hex, no hardcoded px.** Style with `var(--*)` tokens. Same lint config.
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
- **The first staff account cannot come from the API, and that is the design.**
  `POST /v1/staff/users` returns 501 on purpose: an endpoint that mints a working
  staff credential is an endpoint that can be tricked into minting one. Accounts
  come from `apps/api/scripts/provision-staff.mjs`, which runs under Node and
  therefore re-implements PBKDF2, AES-GCM and base32 TOTP against the same
  formats as `src/staff/crypto.ts`. **Nothing at build time connects the two.**
  A parameter change on either side would silently produce a staff account that
  cannot log in and — because the endpoint is 501 — cannot be repaired through
  the API either. `test/staff-crypto.test.ts` pins the script's literal output
  against the Worker's verifiers so that divergence fails a build instead.
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
| 14 | [Admin panel & billing](docs/design/14-admin-panel-and-billing-design.md) | PART 27–29 — staff console, Stripe billing, plan limits |
| 15 | [Frontend/admin/billing prompt](docs/design/15-frontend-admin-billing-implementation-prompt.md) | Standalone build prompt for doc 14 |
| 16 | [Firebase auth & launch prompt](docs/design/16-firebase-auth-and-final-launch-prompt.md) | PART 30 — the auth model in force. Read before touching sign-in |
| 17 | [Dev environment test findings](docs/design/17-dev-environment-live-test-findings.md) | 7 Sept 2026 live pass against `app-dev` |
| 18 | [Full UI audit & fix prompt](docs/design/18-full-ui-audit-and-fix-prompt.md) | 8–9 Sept 2026 audit, now **Parts 1–10**. Parts 1–6 are closed rounds whose outcomes live in docs 03/06 and the backlog; Parts 7–10 are later live passes and **still carry unresolved findings** — read §9.3–9.5 before assuming a screen works |
| 19 | [MCP public distribution guide](docs/design/19-mcp-public-distribution-guide.md) | How to publish the MCP server for public install: per-client snippets, the official registry, marketplaces. Names the doc-18 §9.4 path-scope question as a launch blocker — see [029](backlog/029-mcp-path-scope-contradiction.md) |

### Design system — [design-system/](design-system/)

Claude Design project `agent-storage-mcp` · `d311bfd0-9751-4a9b-84f4-b33e7a09378e`

| Holds | Detail |
|---|---|
| 32 components | 9 primitives, 9 structure, 5 feedback, 1 developer, 8 AgentDisk-specific |
| 98 tokens | `styles.css` — colour, type, 4px space scale, radius, elevation, motion |
| 26 preview cards | `card.html` per component; these stay upstream, not vendored |
| Runtime bundle | `_ds_bundle.js` — 2083 lines, exposes `window.AgentStorageMcp_d311bf` |
| Lint contract | `_adherence.oxlintrc.json` — prop validation, token enforcement |

The AgentDisk-specific components carry the product thesis: `FileCell` (agent
provenance), `ApiKeyDisplay` (show-once), `PermissionSelector` (least privilege),
`McpToolList` (per-tool scopes), `ActivityRow` (agent vs human actors).

### Skills — [Skill/](Skill/)

| # | Document | Covers |
|---|---|---|
| 1 | [Build](Skill/1%20Build.md) | Toolchain, run/build/test commands for both apps, the expected build baseline, barrel regeneration, adherence checks and their calibration, mutation testing, and how to read a failed pipeline run |

### Backlog — [backlog/](backlog/)

| # | Item | Status |
|---|---|---|
| 001 | [Import the design system](backlog/001-import-design-system.md) | Done |
| 002 | [Reconcile brand drift](backlog/002-reconcile-brand-drift.md) | Done |
| 003 | [Scaffold `apps/web`](backlog/003-scaffold-web-app.md) | Done |
| 004 | [MVP-0 screens](backlog/004-mvp0-screens.md) | Done |
| 005 | [MVP-1 screens](backlog/005-mvp1-screens.md) | Done |
| 006 | [Upstream the Drawer](backlog/006-upstream-drawer.md) | Open — design-system gap |
| 007 | [Browser-verify the screens](backlog/007-browser-verify-screens.md) | Open — 4 of 31 rendered, no state variants |
| 008 | [Backend: D1, R2, REST, MCP](backlog/008-backend.md) | Done — REST, MCP and Firebase auth all shipped |
| 009 | [Wire screens to the API](backlog/009-wire-screens-to-api.md) | Reopened — fixture data remains; see [023](backlog/023-non-functional-ui-controls.md). Scope-name conflict decided: the API's bare names win |
| 010 | [Test suite](backlog/010-test-suite.md) | Open — 519 API tests, 105 web tests, route components covered and mutation-checked; e2e still uncovered |
| 011 | [Rename `Worlflow.md`](backlog/011-rename-workflow-file.md) | Open — trivial |
| 012 | [Put the project under git](backlog/012-initialise-git.md) | Done |
| 013 | [Deploy the dashboard](backlog/013-deploy-dashboard.md) | Done — `app-dev.agentdisk.io` |
| 014 | [R2 signing credential](backlog/014-r2-signing-credential.md) | Done — `R2_FILES_*` set on the `dev` environment |
| 015 | [Rename in the design system](backlog/015-rename-in-design-system.md) | Open — upstream change, then re-import |
| 016 | [Upstream the workspace switcher](backlog/016-upstream-workspace-switcher.md) | Open — `AppShell.workspaceSlot` and a selection menu |
| 017 | [Enforce the declared limits](backlog/017-enforce-declared-limits.md) | Open — billing block, period reset, request count and plan sub-limits all unenforced |
| 018 | [Reclaim abandoned uploads](backlog/018-reclaim-abandoned-uploads.md) | Open — `pending` rows and their objects are never swept |
| 019 | [Rate-limit the authenticated surface](backlog/019-rate-limit-authenticated-surface.md) | Open — only the sandbox route is limited |
| 020 | [Staff console defects](backlog/020-staff-console-defects.md) | Open — fleet search throws; force-logout 500s after succeeding |
| 021 | [Audit-trail gaps](backlog/021-audit-trail-gaps.md) | Open — recursive folder delete, move, copy, restore unrecorded |
| 022 | [Finish webhooks](backlog/022-webhook-gaps.md) | Open — 4 of 6 events never emitted; secret stored in plaintext |
| 023 | [Non-functional UI controls](backlog/023-non-functional-ui-controls.md) | Open — Tier 2 closed and 3 of 8 false successes fixed; 5 remain |
| 024 | [Pricing page drift](backlog/024-pricing-page-drift.md) | Open — every number contradicts `plans.ts`; no purchase path |
| 025 | [Authorization hardening](backlog/025-authorization-hardening.md) | Open — agent keys can read billing; five smaller items |
| 026 | [Upstream the account menu](backlog/026-upstream-account-menu.md) | Open — `AppShell.userSlot`; third divergence in the vendored shell |
| 027 | [Files page first paint](backlog/027-files-page-first-paint.md) | Open — three serial round trips before the first file query; measured, not slow |
| 028 | [Staff console security headers](backlog/028-admin-console-security-headers.md) | Open — `apps/admin` has the gap `apps/web` just closed |
| 029 | [MCP path-scope contradiction](backlog/029-mcp-path-scope-contradiction.md) | Open — live testing and the code disagree; unresolved, blocks the public MCP launch |

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
apps/api    519 tests across 29 files · typecheck clean · lint clean
apps/web    105 tests · 114 modules · build clean
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
it on the same bill. Roles are owner / admin / reader.

The REST surface covers files (both upload paths, move, copy, soft delete,
restore), folders, search, agents, keys, members, webhooks, activity, billing,
and workspaces — including `DELETE /v1/workspaces/:id`, which destroys one and
everything in it.
The MCP server exposes ten tools at `/mcp` in the same Worker — each one calls
the REST handler that already does the work, so the two surfaces are literally
the same code and cannot drift in what they allow.

An hourly cron purges soft-deleted objects past their 24-hour grace period and
reconciles the usage counters against the rows.

### What is not built

- **Editable plans and pricing** (doc 14 PART 29.6). The staff console lists
  plans; it cannot change one or push a price to Stripe.
- **Multipart upload** and **signed permanent links**.
- **Full-text search inside files.** Search covers names, paths, captions and
  tags, and the response names the fields it looked at.
- **`openapi.yaml`**, and the generated docs site.
- **Production.**

A second category, found by the 8 Sept 2026 audit ([summary.md](summary.md)):
things that *appear* built and are not connected. Several declared limits are
never enforced — the `past_due` write block above all — and a set of dashboard
controls report success for work that never happened. The isolation and
authentication core is sound; the wiring around it is not finished. See
[017](backlog/017-enforce-declared-limits.md)–[025](backlog/025-authorization-hardening.md).

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
