# Regression tests

A live-site suite. It runs against a **deployed** AgentDisk dashboard and asks
one question: *did a change to how the site looks break how it works?*

Everything follows from that question:

- **Assertions are on roles, accessible names, URLs and network behaviour —
  never on class names, colours, spacing or screenshots.** A re-theme is
  supposed to change all of those. If a cosmetic change can fail this suite,
  the suite is useless for the job it exists to do.
- **`BASE_URL` is the only thing that varies between runs.** Baseline against
  `app-dev`, verification against the preview Worker, then against `app-dev`
  again after merge. A difference in results is a difference in the build.
- **No retries.** A flaky pass turns "intermittently broken" into "green",
  which is the one outcome that makes a baseline comparison lie.

## Setup

```sh
npm install
npm run install-browsers
cp .env.example .env      # then fill in TEST_EMAIL / TEST_PASSWORD
npm run login             # mints .auth/state.json
```

`npm run login` drives the real sign-in form rather than calling Firebase
directly — signing in is itself part of what a re-theme can break, and a script
that bypassed the form would happily produce a green suite for a build whose
login page no longer works. It creates the account through the signup UI if it
does not exist yet, and is safe to re-run.

`.env` and `.auth/` hold a live credential for the dev test account. Both are
gitignored. Keep it that way.

## Running

```sh
npm test                                        # against BASE_URL from .env
BASE_URL=https://preview.example.workers.dev npm test
```

## Baseline and comparison

```sh
# 1. Before any change, against the current site:
npm test
node scripts/snapshot.mjs save baseline/app-dev.json

# 2. After the change, against the preview deployment:
BASE_URL=<preview-url> npm test
node scripts/snapshot.mjs compare baseline/app-dev.json
```

`compare` exits non-zero only on a test that **passed at baseline and fails
now**, or one that has vanished from the run. Newly-added and newly-fixed tests
are reported and never block. That is deliberately the narrow rule the
migration brief sets, and nothing wider.

## What is covered

| Spec | Project | Covers |
|---|---|---|
| `public.spec.js` | public | Landing, pricing, docs, terms, privacy: content, CTAs, every internal link, asset loading |
| `auth-screens.spec.js` | public | Login, signup, forgot-password: fields, submit, provider buttons, cross-links, typing, validation |
| `error-pages.spec.js` | public | 403, 500, maintenance, unknown paths — none may render blank |
| `security.spec.js` | public | The five security headers, CSP directives, uniform 401s across 11 API routes, signed-out redirects |
| `dashboard.spec.js` | authed | All 11 workspace screens render; every destination reachable; sign-out, workspace switcher, create dialogs, Escape-to-close |
| `workspace.spec.js` | authed | No silent workspace-ID substitution; the two failure kinds are indistinguishable; the ID chip survives |

The `public` project runs with **no** stored session on purpose — half the
surface under test is what a signed-out stranger sees, and running it with a
session would silently skip the redirect behaviour it exists to check.

## What is deliberately not covered

- **Visual fidelity.** By design, see above. Compare screenshots by eye.
- **Uploading real files.** The suite opens create dialogs but never submits
  them, so a run leaves no state behind beyond the test account's session.
- **Billing and Stripe.** Reaching the portal leaves the origin.
