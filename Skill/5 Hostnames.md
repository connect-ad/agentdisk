# 5 · Hostnames

Which hostname serves what, what may be indexed, and how the public pages are
produced. The dashboard's internals are [10 Dashboard](10%20Dashboard.md).

---

## The map

| Prod | Dev | Serves |
|---|---|---|
| `agentdisk.io` | `dev.agentdisk.io` | The marketing site: `/`, `/pricing`, `/docs`, `/sandbox`, `/terms`, `/privacy` |
| `www.agentdisk.io` | none | 301 to the apex |
| `app.agentdisk.io` | `app-dev.agentdisk.io` | The dashboard, every signed-in screen, and the same marketing pages with noindex |
| `api.agentdisk.io` | `api-dev.agentdisk.io` | REST, and MCP at `/mcp` |
| `mcp.agentdisk.io` | `mcp-dev.agentdisk.io` | The same Worker, for clients that want a dedicated MCP host |
| `securepanel.agentdisk.io` | `securepanel-dev.agentdisk.io` | The admin console. Not `admin.`, because that is the first thing a scan tries |

## One bundle, two hostnames

Since 30 September 2026 the site and the dashboard are one `apps/web` build
on one Worker with two custom domains, so they can never be at different
versions. `apps/web/worker.js`, the only Worker code this app has, runs before
the assets and decides by hostname:

- `www.` is a 301 to the site.
- On the site host, only the marketing routes and files are served; every
  other path is a 302 to the same path on the app host, so a link that predates
  the split keeps working and a crawler sees a redirect rather than a copy.
- On the app host everything is served, with `X-Robots-Tag: noindex` and a
  `Disallow: /` robots.txt, in every environment.

The SPA makes the matching decisions after it loads (`src/lib/hosts.js`): `/`
on the app host goes to `/app`, and the `AppHostOnly` layout route in
`App.jsx` hard-navigates an app route opened on the site host. **The Worker's
`SITE_ROUTES` and that route group are the same list in two files, and must
stay so.**

Both hostnames are baked in at build (`VITE_SITE_HOST`, `VITE_APP_HOST`) from
the environment's `SITE_DOMAIN` and `WEB_DOMAIN`, which CI asserts against
Terraform's `site_url` and `web_url`, and `[env.<ws>.vars]` in
`apps/web/wrangler.toml` restates them for the Worker. **Unset means the
single-host product**: `npm run dev`, the tests, the harness and the prerender
see one host and behave as before.

The landing page and the docs open the sandbox dialog, so the site hostname is
also in the Turnstile widget's `domains`, in `TURNSTILE_ALLOWED_HOSTNAMES` and
in `CORS_ALLOWED_ORIGINS`. **Four places, changed together.**

## Only prod may be indexed, and only the site

`isIndexable` in `scripts/security-headers.js` answers yes for `prod` alone,
from the deploy job's `ENVIRONMENT_NAME`; Vite's `mode` is `production` for
both environments and cannot tell them apart. An unset name means noindex, so
a local build or a caller that drops the variable ships an unlisted site rather
than an indexed staging one.

Three mechanisms come from that one answer, for three crawler populations: the
`X-Robots-Tag` header in `dist/_headers`, a generated `dist/robots.txt` (with
no file there the SPA fallback answers `/robots.txt` with `index.html` and 200,
which a crawler reads as "no rules"), and a `<meta name="robots">` injected at
build. The smoke test checks the direction the environment demands, so a prod
carrying noindex fails too.

Prod's robots.txt also carries a Content Signals line, a group refusing
training crawlers and a `Sitemap:` line, and the build writes `sitemap.xml`
from the prerendered route list. On the site host the Worker answers a
missing file with a real 404 rather than the SPA fallback. Both are in
[12 Hardening](12%20Hardening.md).

The API Worker and the admin console refuse indexing in every environment;
neither has a prod in which being found would be right.

## Security headers

The dashboard's headers live in `dist/_headers`, written at build by the
`agentdisk-security-headers` plugin from `scripts/security-headers.js`, and
nothing else fails if they stop being emitted. The smoke test's header section
is the only thing that turns that into a red pipeline. The CSP names the API
origin and the Firebase auth domain the bundle was built with, so it cannot
describe a different backend than the app calls. COOP is absent and
`style-src` allows `'unsafe-inline'` for reasons recorded in the script's
header.

Two headers the build does not emit, `Permissions-Policy` and
`Cross-Origin-Opener-Policy: same-origin-allow-popups`, are added at the edge
by a Cloudflare Transform Rule on the site and app hostnames since
30 September 2026. The rule, and the SEO findings against the prerendered
pages (soft 404s, missing sitemap, four routes not prerendered), are in
[12 Hardening](12%20Hardening.md).

## The public pages are static HTML

`npm run build` ends with `scripts/prerender.mjs`, which renders `/`,
`/pricing` and `/docs` with react-dom/server into `index.html`, `pricing.html`
and `docs.html`. Flat files, not directories, because the asset server's
trailing-slash handling would redirect `/pricing` to `/pricing/` for
`pricing/index.html`.

The client does not hydrate: `main.jsx` mounts with `createRoot` and React
discards the markup on its first commit. The trap is that `index.html` is also
the SPA fallback for every deep link, so a refresh on `/w/acme/files` would
paint the homepage for a few hundred milliseconds. Each page therefore carries
`<meta name="agentdisk:prerendered">` naming its route, and
`public/prerender-guard.js`, a plain external script because the CSP allows
nothing inline, hides the markup before first paint when the meta and the URL
disagree, or when `/` is opened on the app host.

**Nothing in the prerendered trees may touch a browser global while
rendering.** Effects are fine. `test/prerender.test.jsx` renders all three
routes under Node, not jsdom, so a component that reads `window` at render
fails the suite rather than the deploy.

Per-route metadata rides the same mechanism. `src/lib/seo.js` is one table of
title and description per public route, read by the prerender and by the live
SPA, so a tab and a search result cannot differ. `SITE_ORIGIN` there is
`https://agentdisk.io` in every environment: only prod is indexable, and a
staging page whose canonical names production is the standard way to say so.
That file is imported by Node outside Vite, so it stays plain JavaScript with
no `import.meta.env`. The social image is the logo; a 1200×630 card does not
exist.

`apps/web/public/llms.txt` tells a model that arrives at the site cold how to
provision a sandbox and where each secret goes.
