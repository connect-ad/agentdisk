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

## Markdown for agents

Every prerendered page on the site host negotiates: a request whose
`Accept` names `text/markdown` at least as strongly as `text/html` gets
its twin (`index.md`, `pricing.md`, `blog/<slug>.md`...) with `Content-Type: text/markdown`,
`Vary: Accept` and an `x-markdown-tokens` estimate (characters ÷ 4). Every
other request, every browser included, gets the HTML, which also carries
`Vary: Accept`. The `.md` files are written by `scripts/prerender.mjs` from
the same rendered markup as the HTML, through `scripts/page-markdown.mjs`
(`node-html-markdown`, a build-only dependency). The nav, icons, buttons and
form controls are dropped; title, description and canonical URL go in front
matter. The files are also reachable by name (`/docs.md`).

Cloudflare's zone-level Markdown for Agents would do this at the edge with no
code, but it needs the Pro plan and the zone is Free. **A top-level route
added to `PRERENDERED_ROUTES` needs its entry in `MARKDOWN_PAGES` in
`worker.js`**; pages under `/blog/`, `/compare/` and `/alternatives/` are
covered by the `SITE_SECTIONS` pattern instead. `markdownTwin()` answers for
both, and `test/prerender.test.jsx` fails until it agrees with the build. The
app host and single-host mode never negotiate.

## Agent discovery documents

The build also writes the documents the Cloudflare Agent Readiness checks
look for, from `scripts/agent-discovery.js` in the same plugin that writes
robots.txt: `/auth.md`, `/openapi.json`, `/.well-known/api-catalog`,
`/.well-known/mcp/server-card.json`, `/.well-known/agent-skills/index.json`
with its `SKILL.md` (llms.txt with front matter, digest computed at build),
and `/.well-known/ai-catalog.json`. Every URL in them comes from
`VITE_API_BASE`, `VITE_SITE_HOST` and `VITE_APP_HOST`, so dev's documents
name dev; a build missing any of the three writes none. The Worker serves
them with `Access-Control-Allow-Origin: *`, and the API catalog as
`application/linkset+json`, which the asset server cannot infer from a file
with no extension. The homepage `Link` header names the catalog.

The OpenAPI document lists the agent-facing routes only, and **the MCP server
card restates `SERVER_INFO` and `PROTOCOL_VERSION` from
`apps/api/src/mcp/server.ts`**: `test/agent-discovery.test.js` fails when the
API's version moves and the card does not.

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

`npm run build` ends with `scripts/prerender.mjs`, which renders every public
page with react-dom/server into a flat file per route: `index.html`,
`pricing.html`, `security.html`, `blog/<slug>.html` and so on, 33 pages as of
4 Oct 2026. Flat files, not directories, because the asset server's
trailing-slash handling would redirect `/pricing` to `/pricing/` for
`pricing/index.html`. The same script writes `sitemap.xml` from the same list,
so the sitemap cannot name a page the build did not write.

The client does not hydrate: `main.jsx` mounts with `createRoot` and React
discards the markup on its first commit. The trap is that `index.html` is also
the SPA fallback for every deep link, so a refresh on `/w/acme/files` would
paint the homepage for a few hundred milliseconds. Each page therefore carries
`<meta name="agentdisk:prerendered">` naming its route, and
`public/prerender-guard.js`, a plain external script because the CSP allows
nothing inline, hides the markup before first paint when the meta and the URL
disagree, or when `/` is opened on the app host.

**Nothing in the prerendered trees may touch a browser global while
rendering.** Effects are fine. `test/prerender.test.jsx` renders every
route under Node, not jsdom, so a component that reads `window` at render
fails the suite rather than the deploy.

## The long-form pages (4 Oct 2026)

The trust pages (`/security`, `/privacy`, `/terms`, `/trust`,
`/sub-processors`, in `routes/Trust.jsx`), the blog (`/blog`,
`/blog/:slug`), the comparisons (`/compare`, `/compare/:slug`), the
alternatives (`/alternatives`, `/alternatives/:slug`) and the four
`/storage-for-<agent>` pages. They share one frame,
`components-local/Prose.jsx`, which reuses the docs' `doc__*` prose classes
and adds the `pg__*` layout in `app.css`; every FAQ on them is also written
as FAQPage JSON-LD, and posts carry BlogPosting JSON-LD.

- **Content is data.** Posts are markdown in `src/content/blog/*.md`, parsed
  by `lib/markdown.js`, a dependency-free parser for a fixed subset documented
  in its header. Comparisons, alternatives and agent pages are
  `src/content/compare.js` and `src/content/agents.js`. Adding a post or a
  comparison is adding data: `lib/pages.js` gathers their titles and routes,
  and the prerender, the sitemap and the live `PageMeta` all read it.
- **Two metadata sources.** `lib/seo.js` keeps the hand-written pages and
  stays importable by plain Node; content pages pass their table as the
  `extra` argument of `metaFor`, `headTags` and `applyPageMeta`.
- **Four routing lists must agree** for a new top-level page: the route in
  `App.jsx` above `AppHostOnly`, `SITE_ROUTES` and `MARKDOWN_PAGES` in
  `worker.js`, and an entry in `PAGE_META` or the content files.
- **The old trust anchors forward.** `/docs#data-security`, `#safety`,
  `#privacy` and `#terms`, and the `/docs/<id>` forms, redirect from
  `Docs.jsx` (`TRUST_MOVED`).
- **There is no `/dpa`.** A DPA is a contract, and the Privacy Policy still
  leaves transfer mechanisms and governing law to be specified; the Trust
  Center says to write in instead. Competitor facts on the comparison pages
  come from the owner's brief of 4 Oct 2026 and say so on the page; they do
  not update themselves.

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
