# 1 · Build

How to run, build, check and deploy this project. Everything here was observed
on the current tree, not copied from the specification.

---

## Toolchain

| | Version | Note |
|---|---|---|
| Node | v24.13.0 | Observed. No `.nvmrc` or `engines` field pins it. |
| npm | 11.6.2 | |
| Vite | 6.4.3 | `package.json` asks for `^6.0.7` |
| React | 18.3.1 | Pinned exactly — **not** `^`. Deliberate: the design system was compiled against it. |
| react-router-dom | ^7.18.3 | |
| TypeScript | ^5.9.0 | `apps/api` only; `apps/web` is plain JSX |
| Wrangler | ^4.129.0 | Both apps |
| Terraform | 1.16.1 | **>= 1.11 is mandatory** — see `CLAUDE.md`. A 1.6.x binary refuses the config outright. |

Two apps, `@agentdisk/web` and `@agentdisk/api`, each with its own
`package.json`. There is no root `package.json` and this is not an npm
workspaces monorepo, so run npm from inside `apps/web` or `apps/api`, never the
root.

---

## Run it

```bash
cd apps/web
npm install       # first time only
npm run dev       # vite dev server
npm run build     # vite build -> dist/, with sourcemaps
npm run preview   # serve the built dist/
npm test          # vitest run, jsdom (vitest.config.js, separate from vite.config.js)
```

```bash
cd apps/api
npm install
npm run dev       # wrangler dev
npm run typecheck # tsc --noEmit  (also the `build` script)
npm run lint      # oxlint src test
npm test          # vitest run
```

### Expected build output

Keep this as the regression baseline. A large deviation means something was
pulled in that shouldn't have been:

```
114 modules transformed
dist/index.html                   0.39 kB │ gzip:   0.26 kB
dist/assets/index-*.css          38.89 kB │ gzip:   7.15 kB
dist/assets/index-*.js          528.28 kB │ gzip: 144.39 kB │ map: 2,076.94 kB
built in ~1.0s
```

The build also writes **`dist/_headers`**, which Vite does not list. It is
produced by the `agentdisk-security-headers` plugin in `vite.config.js` from
`scripts/security-headers.js`, and it is the only thing that puts security
headers on the deployed site — `apps/web` is an assets-only Worker, so there is
no request-path code to set them (06 PART 16.9a). It is absent from a `vite
build --watch`-style dev server too, because the plugin is `apply: 'build'`:
`wrangler dev` in `apps/web` serves the headers, `npm run dev` does not.

Wrangler prints `Parsed 1 valid header rule` when it picks the file up. If that
line is missing the file did not make it into `dist/`, and the deploy will
silently serve no headers at all — nothing else fails.

Vite warns that the JS chunk is over 500 kB. Roughly 185 kB of it is the
Firebase SDK, which is expected and not yet worth code-splitting.

`dist/` is ~1.4 MB, almost all of it the sourcemap. It is gitignored.

**The build needs the Firebase config and a Turnstile site key.** Without the
`VITE_FIREBASE_*` values every sign-in button fails at runtime, so CI treats
them as fatal rather than warning - a deploy that looks green and is not is
worse than one that stops. It also refuses outright if a dev build is pointed at
the prod Firebase project, which is otherwise invisible until somebody signs in:

```bash
VITE_TURNSTILE_SITE_KEY=... VITE_API_BASE=https://api-dev.agentdisk.io VITE_FIREBASE_API_KEY=... VITE_FIREBASE_AUTH_DOMAIN=agentdisk-dev.firebaseapp.com VITE_FIREBASE_PROJECT_ID=agentdisk-dev VITE_FIREBASE_APP_ID=... npm run build
```

CI reads both from `terraform output` so the widget the dashboard renders cannot
drift from the widget the API verifies against, and **fails the build** rather
than shipping a challenge that cannot load. A local build without them still
succeeds — the page renders an explanatory warning instead of the form.

---

## Regenerate the component barrel

`apps/web/src/components/index.js` is **generated** from
`design-system/_ds_manifest.json`. Never hand-edit it. Regenerate after any
re-import of the design system.

The manifest's `components[]` gives 32 entries of `{name, sourcePath}` — that
is the module list, and it currently matches the barrel exactly, 32/32.

**The manifest is not sufficient on its own.** Three modules export named
symbols the manifest does not mention, and a naive manifest-driven generator
silently drops them:

| Module | Extra named export |
|---|---|
| `Icon/Icon.jsx` | `iconNames` |
| `McpToolList/McpToolList.jsx` | `mcpTools` |
| `PermissionSelector/PermissionSelector.jsx` | `permissionPresets` |

So: take the module list from the manifest, then read each source for
additional `export const` / `export function` names. 32 modules, 35 exports.

Verify the barrel still agrees with the manifest:

```bash
node -e "
const m=require('./design-system/_ds_manifest.json'), fs=require('fs');
const b=fs.readFileSync('apps/web/src/components/index.js','utf8');
const inBarrel=[...b.matchAll(/from '\.\/([^']+)'/g)].map(x=>x[1]);
const inManifest=m.components.map(c=>c.sourcePath.replace(/^components\//,''));
console.log('barrel',inBarrel.length,'manifest',inManifest.length);
console.log('missing:',inManifest.filter(p=>!inBarrel.includes(p)).join(', ')||'none');
console.log('extra:  ',inBarrel.filter(p=>!inManifest.includes(p)).join(', ')||'none');
"
```

---

## Check adherence

`apps/api` has a real lint script (`oxlint src test`). **`apps/web` does not,
and cannot use the adherence config directly:** oxlint 1.81 refuses to load
`design-system/_adherence.oxlintrc.json`, failing with
`unknown field \`x-omelette\``. The config is still the contract; these greps
approximate it.

**Know what the contract does and does not cover.** Its rules are oxlint
`no-restricted-syntax` selectors matching `Literal` nodes — so they see **JS and
JSX string literals only. CSS files are never linted.** A token violation in
`app.css` will not be caught by the config, only by review.

Run from `apps/web/src`:

```bash
# 1. Raw hex in hand-written code — must be 0
grep -rnoE "'[^']*#[0-9a-fA-F]{3,8}\b[^']*'" routes components-local App.jsx

# 2. Barrel bypass — must be 0
grep -rn "from '\.\./components/[A-Z]" routes components-local

# 3. px in JS/JSX literals — see calibration below
grep -rnoE "'[^']*[0-9]+px[^']*'" routes components-local App.jsx
```

Current state: **0 raw hex, 0 barrel bypass, 3 px literals.**

### Calibration on the px rule

The rule is `Literal[value=/\b\d+px\b/]` at `warn`. It over-matches, and the
design system trips it **25 times in its own components**, including the exact
idiom in question:

```jsx
borderBottom: '1px solid var(--line)'
```

A `1px` hairline has no token — the space scale starts at 4px and is for
spacing, not border width. So treat the rule as: **px must never carry spacing
or sizing.** Hairline borders matching upstream's idiom are fine. The three
current hits (`routes/ActivityLog.jsx`, `routes/Auth.jsx`, `App.jsx` — the
workspace switcher) are all hairlines.

`app.css` additionally holds 6 px values the linter cannot see — container
max-widths (`400px`, `1120px`), a fixed `26px` badge, a `1px` rule and an `8px`
blur. All are layout constants with no corresponding token. Leave them; just
don't add spacing in px.

---

## Design-system integrity

`design-system/` is a **byte-verified mirror** of Claude Design project
`d311bfd0` — 96 files, read-only. `apps/web/src/components/` is a vendored copy
of its component sources.

To re-verify after any re-import, compare every local file's byte size against
`list_files` on the remote. Byte size is the only reliable proof: the MCP
channel HTML-escapes bodies, and a decode-order mistake or a literal `\uXXXX`
escape produces a file that looks right and is one or two bytes wrong. See
`.design-sync/NOTES.md` before attempting any transfer.

`.gitattributes` exempts `design-system/**` from EOL conversion. Without it a
re-clone on Windows would rewrite every line ending and void the verification.

---

## Test

`apps/api` has a real suite: **519 tests across 29 files**, run with
`npm test` from `apps/api`.

It runs inside the **real Workers runtime against real Miniflare-backed D1 and
R2**, not mocks — doc 09 requires tenant-isolation to be proved against actual
SQL, and a mocked query layer will happily "prove" an isolation guarantee the
real query does not provide. `vitest.config.ts` reads the same `migrations/*.sql`
the deploy applies, in Node, because the Workers runtime has no filesystem; a
separately maintained test schema is how a migration bug survives a green suite.

Two bindings exist only for tests, in `vitest.config.ts`: a dummy
`TURNSTILE_SECRET_KEY` (the bootstrap route fails closed without one, so its
gates would never be reached) and a fake R2 key pair (without one, every presign
path returns "not configured" and the upload/download routes go untested).

### Mutation testing

A test that has never failed has never been shown to test anything. Every
security-critical behaviour in the storage core was verified by deliberately
breaking it and confirming the suite goes red — 22 mutations across two rounds.

Six survived their first pass. Four were genuine gaps (an unasserted column, a
branch made unreachable by an earlier check, an untested grace window, a guard
unreachable over HTTP and so never exercised). **Two were mutations that changed
nothing observable** because a second check still enforced the property — the
`unauthorized()` helper puts its argument in `internalReason`, and folder
creation asserts scope per ancestor as well as up front. When a mutation
survives, establish which of those two it is before adding a test: strengthen
the mutation until it removes the property entirely.

`apps/web` has **105 tests across six files**. The oldest,
`test/dialog-focus.test.jsx`, covers focus behaviour in `Modal` and `Drawer`. It
exists because a focus bug made every dialog in the product unusable, and
because nothing else could catch it: the build is clean either way and there is
no web lint script.

It types through `user.keyboard`, which delivers to `document.activeElement`,
rather than into a named element. **That distinction is the test.** Typing
straight into the field passes with the bug present, because it re-targets the
same element every character; delivering to whatever currently has focus is what
makes a stolen focus show up as `expected 'r' to be 'research-bot'`.

The screens have still never been rendered in a browser beyond four spot checks
([backlog 007](../backlog/007-browser-verify-screens.md),
[backlog 010](../backlog/010-test-suite.md)).

---

## Deploy

**Never deploy by hand.** Push to `dev` and let the pipeline run: it applies
Terraform, injects resource IDs into `wrangler.toml` from `terraform output`,
pushes secrets, runs D1 migrations, deploys, and smoke-tests. The
`deploy:dev` / `deploy:prod` npm scripts exist for local debugging and skip all
of that — a hand deploy ships a `wrangler.toml` still full of `TF_OUTPUT_*`
placeholders.

Four workflows, and they are separate on purpose:

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | PRs, pushes, dispatch | Verify + `terraform plan` for **both** workspaces |
| `deploy-dev.yml` -> `deploy.yml` | push to `dev` | The API pipeline |
| `deploy-web-dev.yml` | push touching `apps/web` or `infra/terraform` | The dashboard, which is assets-only and shares none of the API's migration or secret steps |
| `deploy-admin-dev.yml` | push touching `apps/admin` or `infra/terraform` | The staff console. Same shape as the dashboard's, minus the Turnstile and Firebase build variables the console has no use for |

Live dev hostnames: `api-dev.agentdisk.io`, `mcp-dev.agentdisk.io`,
`app-dev.agentdisk.io`, `admin-dev.agentdisk.io`. **Prod has never been applied** — its workspace plans
`12 to add`, and it is gated behind a PR into `main` plus required-reviewer
approval.

### Provision a staff account

The staff console has no self-service path in or out: `POST /v1/staff/users`
returns 501 by design, so the first account — and every account — is created
from a machine, not from the product.

```bash
cd apps/api
export DATABASE_ENCRYPTION_KEY='...'   # the dev/prod environment secret, same
                                       # value the Worker runs with
node scripts/provision-staff.mjs --email you@example.com --role super_admin --env dev
```

Never pass the key as an argument: arguments are visible in shell history and in
the process list.

The script writes a `.sql` file holding only a password hash and an *encrypted*
TOTP secret, and prints the password, the `otpauth://` URI and the code the
authenticator should be showing right now. **Confirm that code before applying
the SQL.** Enrolling wrong produces an account that cannot log in and cannot be
deleted through the API — there is no repair path short of another direct D1
write. Apply with the `wrangler d1 execute --remote --file` command it prints,
then delete the file.

The one calibration worth knowing: the script re-implements PBKDF2, AES-GCM and
base32 TOTP because it runs under Node rather than Workers. Nothing at build time
ties it to `src/staff/crypto.ts`, so `test/staff-crypto.test.ts` pins its literal
output against the Worker's verifiers. If you change either side's parameters,
that test is what tells you.

### Firebase auth config

Firebase Authentication is provisioned from
[`infra/firebase/firebase.json`](../infra/firebase/firebase.json), not by
clicking through the console:

```bash
cd infra/firebase
npx -y firebase-tools@latest deploy --only auth --project agentdisk-dev
```

This is the only route that works on the free Spark plan. The documented API
for turning auth on — `identityPlatform:initializeAuth` — is the *paid*
Identity Platform tier and answers `BILLING_NOT_ENABLED`; before the config
exists, every other admin call answers `CONFIGURATION_NOT_FOUND`.

**Two things the deploy does that it does not tell you, both verified by
reading the config back afterwards:**

- **It resets `signIn.email.passwordRequired` to `true` every time**, which
  turns **email-link sign-in off**. `firebase.json` has no key for email-link,
  so the deploy cannot express it. Re-assert it after every deploy.
- **It ignores `authorizedDomains` in `firebase.json` on the run that first
  creates the config**, seeding only `<project>.firebaseapp.com` and
  `<project>.web.app`. Later deploys leave an existing list alone. Without
  `app-dev.agentdisk.io` in it, Google sign-in fails with
  `unauthorized-domain`.

Both are set through the admin API instead — the key is `signIn.email` with
`passwordRequired: false`, alongside the full domain list:

```
PATCH https://identitytoolkit.googleapis.com/admin/v2/projects/<project>/config
      ?updateMask=authorizedDomains,signIn.email
```

Verify rather than trust the "Deploy complete!" line: `GET` the same URL and
check `authorizedDomains`, `signIn.email`, and
`defaultSupportedIdpConfigs` (Google and GitHub each need `enabled: true` with
a client ID and secret). GitHub's provider is the one part no API can do — it
needs a GitHub OAuth App per environment, with the callback URL
`https://<project>.firebaseapp.com/__/auth/handler`, and its client secret is
entered in the Firebase console.

### R2 credentials, and the two ways they go wrong

Two different R2 tokens, deliberately not sharing a name:

| Secret | Bucket | Used by |
|---|---|---|
| `R2_STATE_*` (repo level) | `agentdisk-tfstate` | Terraform's S3 backend |
| `R2_FILES_*` (environment) | `agentdisk-<env>-files` | Presigned upload/download URLs |

`deploy.yml` maps `R2_FILES_*` onto the Worker's own `R2_ACCESS_KEY_ID` /
`R2_SECRET_ACCESS_KEY`, where there is only one bucket and the short name is
unambiguous. Both failures below were diagnosed from the error text alone, and
both look like something else at first:

- **`AccessDenied` on the state bucket is not a bad credential.** An unknown key
  answers `InvalidAccessKeyId` and a wrong secret answers
  `SignatureDoesNotMatch`. `AccessDenied` means R2 recognised the credential and
  refused it for that bucket - so the token is intact and its *permissions*
  changed, which GitHub has no way to reflect. Do not start by re-entering the
  GitHub secret; look at the token's bucket scope and expiry in the Cloudflare
  dashboard first.
- **`Credential access key has length 64, should be 32`** means the Access Key
  ID field holds a Secret Access Key. An R2 Access Key ID is 32 hex characters;
  the secret is 64. They sit next to each other in Cloudflare's token screen and
  are trivially swapped.

**A changed secret does not reach the Worker until a deploy runs.** The values
are pushed by `wrangler secret put` inside the deploy job, so updating the
GitHub secret and retrying the request tests the *old* value. Re-run the deploy
first.

### Reading a failed run

```bash
gh run list --limit 5 --json databaseId,name,status,conclusion   --jq '.[] | "\(.databaseId) \(.name) \(.status) \(.conclusion)"'
gh run view <id> --log-failed | sed 's/\[[0-9;]*m//g'
```

The `sed` is not optional in practice — the logs are full of ANSI escapes and
Terraform's box-drawing output is unreadable without stripping them.

**A red "[5] Security headers" is not necessarily a broken deploy.** Check the
live URL by hand before believing it — a deployment's asset content and its
`_headers` rules go live independently, and content wins the race. The first
deploy carrying these headers failed exactly this way: section 1 confirmed the
new hashed bundle was already being served, section 5 found no headers 0.65s
later, and the same URL carried all five, never redeployed, when checked
afterwards. The smoke test now polls for about a minute before failing, so a
red section 5 today means either a genuinely missing `dist/_headers` or a
propagation delay longer than that window.

### A green plan should say "No changes"

`0 to add, 1 to change` on an unmodified dev tree is a **perpetual diff**, not a
signal, and it has now happened twice: `cloudflare_d1_database` sends
`read_replication: null` on update, and `cloudflare_turnstile_widget` returns its
`domains` list sorted so any other declared order re-applies forever. Both are
recorded in `CLAUDE.md`. Chase a persistent "1 to change" rather than learning
to ignore it — the Turnstile one was silently round-tripping a live credential
on every deploy.

Terraform is not installed at a usable version on this machine (`terraform` on
PATH is 1.6.6, which the config refuses). For local `fmt`/`validate`, fetch a
1.16.1 binary into the session scratchpad; never run `apply` locally, and never
`terraform state pull` — the state holds live credentials.
