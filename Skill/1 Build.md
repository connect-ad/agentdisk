# 1 · Build

How to run, build, check and test this project on a machine. Deploying is
[3 Deploy](3%20Deploy.md); nothing here ships anything.

---

## Toolchain

| | Version | Note |
|---|---|---|
| Node | v24 | No `.nvmrc` or `engines` field pins it. |
| Vite | 6 | Both SPAs |
| React | 18.3.1 | Pinned exactly, not `^`. The design system was compiled against it. |
| TypeScript | 5 | `apps/api` only; the two SPAs are plain JSX |
| Wrangler | 4 | All three apps |
| Terraform | 1.16 in CI | **>= 1.11 is mandatory.** The `terraform` on this machine is 1.6.6 and refuses the config; `fmt -check` still works, `validate` does not. Let CI validate. |

Four packages, each with its own `package.json` and no root workspace: run npm
from inside `apps/api`, `apps/web`, `apps/admin` or `apps/cli`, never the root.

---

## Run it

```bash
cd apps/api
npm ci
npm run dev        # wrangler dev
npm run typecheck  # tsc --noEmit (also the `build` script)
npm run lint       # oxlint src test
npm test           # vitest, real Workers runtime, Miniflare D1 + R2
```

```bash
cd apps/web        # same shape for apps/admin
npm ci
npm run dev        # vite; single-host mode, see 5 Hostnames
npm run build      # check-jsx-identifiers → vite build → prerender
npm test           # vitest, jsdom
```

`apps/web` has **no lint script** and CI's `npm run lint --if-present` skips it
silently. The token and barrel conventions are checked by the greps below and
by nothing else.

### Baseline

Re-measure after a merge; these are a snapshot.

```
apps/api   1009 tests · 52 files · typecheck clean
apps/web    469 tests · 41 files · build clean
apps/admin   52 tests ·  4 files · build clean · 110 KiB gzipped
apps/cli     11 tests ·  1 file  · no dependencies · not published, not in CI
Worker      226 KiB gzipped against Cloudflare's 1 MB limit
```

### What the web build needs

The bundle bakes in the Firebase web config, the API origin, the Turnstile
site key and, on a split deploy, both hostnames. Without `VITE_FIREBASE_*`
every sign-in button fails at runtime, so CI treats a missing one as fatal, and
refuses a dev build pointed at the prod Firebase project.

```bash
VITE_API_BASE=https://api-dev.agentdisk.io \
VITE_TURNSTILE_SITE_KEY=... \
VITE_FIREBASE_API_KEY=... VITE_FIREBASE_AUTH_DOMAIN=agentdisk-dev.firebaseapp.com \
VITE_FIREBASE_PROJECT_ID=agentdisk-dev VITE_FIREBASE_APP_ID=... \
ENVIRONMENT_NAME=dev npm run build
```

`ENVIRONMENT_NAME` decides indexability; unset means noindex. The build also
writes `dist/_headers`, `dist/robots.txt` and the three prerendered pages,
which Vite does not list. Wrangler prints `Parsed 1 valid header rule` when it
picks the headers up; without that line the deploy serves no security headers
and nothing else fails.

**No source maps in `dist`**, for either SPA. Both configs are
`sourcemap: false`; use `'hidden'` for local debugging and never let `*.map`
reach `dist`, because the asset server uploads everything in it and this
codebase's comments say where every guard is.

---

## Regenerate the component barrel

`apps/web/src/components/index.js` is generated from the design system's
manifest. Never hand-edit it. The manifest lists the modules; three of them
also export a named symbol the manifest does not mention (`iconNames`,
`mcpTools`, `permissionPresets`), so a generator has to read each source for
extra `export const` / `export function` names as well. 32 modules, 35 exports.

The mirror of the Claude Design project no longer lives in this repository;
`design-system/` holds four hand-exported artboards and the logo. Re-import
from Claude Design when a component changes upstream, then regenerate.

---

## Check adherence

Conventions with no tool behind them: import components from the barrel only,
no raw hex, no hardcoded px for spacing, every status pairs a colour with a
word. Run from `apps/web/src`:

```bash
grep -rnoE "'[^']*#[0-9a-fA-F]{3,8}\b[^']*'" routes components-local App.jsx   # must be 0
grep -rn "from '\.\./components/[A-Z]" routes components-local                  # must be 0
grep -rnoE "'[^']*[0-9]+px[^']*'" routes components-local App.jsx               # hairlines only
```

The px rule over-matches: a `1px solid var(--line)` hairline has no token and
is the upstream idiom. Treat it as "px never carries spacing or sizing".
`app.css` is never linted by anything; a raw hex there is caught by review.

---

## Test

`apps/api` runs in the real Workers runtime against Miniflare-backed D1 and R2,
reading the same `migrations/*.sql` the deploy applies. A mocked query layer
would happily prove an isolation guarantee the real query does not provide.
`vitest.config.ts` supplies a dummy Turnstile secret and a fake R2 key pair so
the gated routes are reachable. `resetRateLimits()` between tests, because the
auth throttle lives in KV.

Every security-critical behaviour in the storage core was mutation-tested: 22
deliberate breaks, each confirmed to turn the suite red. When a mutation
survives, decide whether it is a gap or a property enforced twice before adding
a test.

`apps/web` tests type through `user.keyboard`, which delivers to
`document.activeElement`. That is the test: a stolen focus shows up as the
wrong element receiving the characters.

Every checkout test is a refusal that returns before the outbound Stripe call.
`test/checkout-params.test.ts` asserts the session parameters as a value,
because two defects shipped through that gap with the suite green.

### Rendering the screens in a real browser

jsdom computes no layout. `apps/web/harness/` serves the real app through Vite
with sign-in stubbed and every `/v1/*` call mocked, and drives the installed
Chrome through `playwright-core`. Nothing in it is deployed.

```bash
cd apps/web
npm i --no-save playwright-core
npx vite --config harness/vite.harness.config.js &   # 127.0.0.1:5199
node harness/audit.mjs out/            # every route × 12 viewports
node harness/audit.mjs out/ keys 390   # one route, one width
node harness/interact.mjs out/ 360     # menus, drawers and dialogs
```

`audit.mjs` prints `FAIL` for sideways scroll or an element outside the
viewport. It cannot see crushed text; look at the screenshots. Two recurring
failures are not bugs: `key-state` needs the table scrolled before the tap, and
`settings-members` reports `OUT` because a data table scrolls inside its panel.

The responsive rules live in one section at the end of `src/app.css`, every one
under a `max-width` query, and `test/responsive.test.jsx` keeps it that way.

### The live-site regression suite

`regression-tests/` is Playwright against a deployed dashboard. It asserts on
roles, names, URLs and network behaviour, never on class names, colours or
screenshots, so a re-theme cannot fail it. `BASE_URL` is the only thing that
varies. No retries. Take a fresh baseline before a visual change and compare
after; the September baselines were deleted with the production reset.

---

## Reading a failed run

```bash
gh run list --limit 8 --json databaseId,workflowName,status,conclusion --jq '.[] | "\(.databaseId) \(.workflowName) \(.status)/\(.conclusion)"'
gh run view <id> --log-failed | sed 's/\x1b\[[0-9;]*m//g'
```

The `sed` matters; Terraform's box drawing is unreadable under ANSI escapes.
The log's step column is often `UNKNOWN STEP`, so grep for the text you expect
rather than filtering by step.

Two errors that read as something else, both recorded because they cost real
time: an R2 `AccessDenied` means the credential is valid and its permissions
moved, not that the secret is wrong; and `Credential access key has length 64,
should be 32` means an Access Key ID field holds a Secret Access Key.
