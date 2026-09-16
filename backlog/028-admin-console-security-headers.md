# 028 · Security headers on the staff console

**Status:** Open — `apps/web` is fixed, `apps/admin` has the identical gap.

`apps/admin/wrangler.toml` has the same shape that left the dashboard without
security headers: `[assets] directory = "./dist"`, `not_found_handling =
"single-page-application"`, and no `main`. There is no request-path code to set
headers and no `_headers` file, so every document response from
`admin-dev.agentdisk.io` carries none of the five.

This was found while fixing `apps/web` and deliberately left alone to stay in
the scope of that request — not because it is acceptable. It is arguably the
worse of the two surfaces: 14 PART 27.2 scopes the staff session cookie to this
origin precisely so a staff credential and a customer credential cannot reach
each other in a browser, and clickjacking or a script injection here acts on a
session that can read every tenant's workspace.

## What it takes

`apps/web/scripts/security-headers.js` is written to be the single source for a
build, its tests and the smoke test, so the mechanism ports directly. The policy
does not: the console **deliberately does not import `design-system/`**, does
not load Google Fonts, and authenticates with its own staff session rather than
Firebase — so the `style-src`/`font-src` sources and the whole Firebase and
Turnstile surface of the dashboard's CSP should be absent here, not copied.
Copying the dashboard policy wholesale would grant the console a list of origins
it has no reason to talk to, which is the opposite of the point.

Check what `apps/admin` actually loads before writing the policy, the same way
the dashboard's was derived — the dashboard's `style-src 'unsafe-inline'` exists
only because 41 files use React `style={{…}}`, and that count has to be
re-established here rather than assumed.

## Done when

The five headers are present on the console's document root and on an SPA deep
link, proven against a running server rather than against the generated file,
and a smoke-test assertion fails the deploy if they ever stop being emitted.
