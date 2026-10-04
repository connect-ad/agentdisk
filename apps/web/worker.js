/**
 * The Worker in front of the dashboard's static assets.
 *
 * One bundle, one deploy, two hostnames. The marketing site (agentdisk.io,
 * dev.agentdisk.io) and the dashboard (app.agentdisk.io, app-dev.agentdisk.io)
 * are the same Worker serving the same `dist/`; this file is what makes them
 * behave as two sites. Until 30 Sept 2026 the Worker had no code at all -
 * assets only - and the landing page lived on the app hostname while the
 * brand domain served a site-builder placeholder.
 *
 * What it decides, by hostname:
 *
 *   www.<site>     301 to the site. Nothing is ever served here.
 *   <site>         The marketing routes and the files they need are served
 *                  from the assets. Any other path - /login, /signup, a
 *                  workspace deep link - is a 302 to the same path on the
 *                  app host, so a link that predates the split keeps working
 *                  and a crawler sees a redirect rather than a copy.
 *                  A file that does not exist is a real 404, and `/` carries
 *                  a Link header naming llms.txt and the docs (3 Oct 2026).
 *                  `/`, `/pricing` and `/docs` asked for with
 *                  `Accept: text/markdown` answer their markdown twin from
 *                  the build (4 Oct 2026); HTML stays the default. The
 *                  agent discovery documents (auth.md, the API catalog, the
 *                  MCP server card...) are served readable from any origin.
 *   anything else  The app: every path is served, and the response says
 *                  noindex. The app host is never indexed once the site
 *                  exists; the canonical URLs in the marketing pages already
 *                  name the site.
 *
 * `run_worker_first` in wrangler.toml sends EVERY request here, including
 * hashed assets, because the www redirect and the site-host allowlist have to
 * see requests for files too. `_headers` and `not_found_handling` still apply
 * to whatever `env.ASSETS.fetch` returns, so the security headers and the SPA
 * fallback are unchanged.
 *
 * With no SITE_HOST configured (local `wrangler dev`, a preview) every request
 * is passed straight to the assets and nothing is rewritten: single-host
 * mode, which is what the product was before this file existed.
 *
 * Plain ES module with no imports so Wrangler needs no bundling config and
 * the unit test (test/site-worker.test.js) can import it directly.
 */

/**
 * Routes that render on the marketing host. Everything else belongs to the
 * app. Mirror of the site-side route group in src/App.jsx; the SPA's gate
 * (`AppHostOnly`) covers client-side navigation and this covers the first
 * request, so the two lists must agree.
 */
const SITE_ROUTES = new Set(['/', '/pricing', '/docs', '/sandbox', '/terms', '/privacy']);

/**
 * The site pages that have a markdown twin in `dist/`, written beside the
 * HTML by scripts/prerender.mjs from the same rendered markup. Cloudflare's
 * zone-level Markdown for Agents would convert at the edge, but it needs the
 * Pro plan; the zone is on Free.
 */
export const MARKDOWN_PAGES = { '/': '/index.md', '/pricing': '/pricing.md', '/docs': '/docs.md' };

/** The robots.txt the app host always answers. */
const APP_ROBOTS = 'User-agent: *\nDisallow: /\n';

/** The header twin of `<meta name="robots">`. Same value as ROBOTS_NOINDEX in scripts/security-headers.js. */
const ROBOTS_NOINDEX = 'noindex, nofollow';

function normalize(pathname) {
  return pathname.replace(/\/+$/, '') || '/';
}

/** True for a path the marketing host serves rather than redirects. */
export function isSitePath(pathname) {
  const path = normalize(pathname);
  if (SITE_ROUTES.has(path)) return true;
  if (path.startsWith('/docs/')) return true;
  // Hashed bundles, and any file by name: robots.txt, llms.txt, the logo,
  // the prerender guard, pricing.html itself. A route never has an extension.
  if (path.startsWith('/assets/')) return true;
  if (path.startsWith('/.well-known/')) return true;
  if (/\.[a-z0-9]+$/i.test(path)) return true;
  return false;
}

/**
 * True for a path that names a file rather than a page: anything with an
 * extension, anything under /assets/ or /.well-known/. On the site host these
 * must answer 404 when the file is missing.
 */
export function isFilePath(pathname) {
  const path = normalize(pathname);
  if (path.startsWith('/assets/') || path.startsWith('/.well-known/')) return true;
  return /\.[a-z0-9]+$/i.test(path);
}

/**
 * The homepage's Link header (RFC 8288), for agents that read headers before
 * bodies. Only files that exist on every deploy are named.
 */
export const HOMEPAGE_LINKS = [
  '</llms.txt>; rel="describedby"; type="text/plain"',
  '</docs>; rel="service-doc"; type="text/html"',
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"'
].join(', ');

/**
 * The agent discovery documents written by scripts/agent-discovery.js. Each is
 * public and carries no credential, so any origin may read it (the ARD check
 * requires `Access-Control-Allow-Origin: *`). The API catalog has no file
 * extension, so the asset server cannot infer the media type RFC 9727 names.
 */
export const DISCOVERY_TYPES = {
  '/.well-known/api-catalog': 'application/linkset+json',
  '/.well-known/ai-catalog.json': null,
  '/.well-known/mcp/server-card.json': null,
  '/.well-known/agent-skills/index.json': null,
  '/.well-known/agent-skills/agentdisk/SKILL.md': null,
  '/openapi.json': null,
  '/auth.md': null
};

/**
 * True when an Accept header asks for markdown at least as strongly as for
 * HTML. A browser never names text/markdown, so it always gets HTML; an
 * agent sending `Accept: text/markdown` gets markdown. `*\/*` counts for
 * neither, since it expresses no preference between the two.
 */
export function prefersMarkdown(accept) {
  if (!accept) return false;
  let markdown = 0;
  let html = 0;
  for (const part of accept.split(',')) {
    const [type, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    const weight = q ? Number(q.slice(2)) || 0 : 1;
    if (type.trim() === 'text/markdown') markdown = Math.max(markdown, weight);
    if (type.trim() === 'text/html') html = Math.max(html, weight);
  }
  return markdown > 0 && markdown >= html;
}

/**
 * True when the asset server answered a file path with the SPA shell: the
 * `not_found_handling` fallback, which returns index.html with 200 for any
 * path it has no file for. A real .html file is the one HTML answer that is
 * not a miss.
 */
export function isSpaFallback(pathname, response) {
  if (/\.html?$/i.test(pathname)) return false;
  const type = response.headers.get('content-type') || '';
  return type.toLowerCase().startsWith('text/html');
}

/**
 * What to do with a request, as data. Pure, so the test can assert every
 * branch without a fetch.
 *
 * Returns one of:
 *   { kind: 'assets' }       serve from the assets as-is
 *   { kind: 'site-home' }    the site's `/`, with the Link header added
 *   { kind: 'site-page' }    a site page that also has a markdown twin
 *   { kind: 'site-markdown', file }  that twin, for an agent that asked
 *   { kind: 'site-file' }    a file on the site host: the asset, or a 404
 *   { kind: 'app-assets' }   serve from the assets, marked noindex
 *   { kind: 'robots' }       the app host's own robots.txt
 *   { kind: 'redirect', status, location }
 */
export function decide(url, env, accept = '') {
  const site = env.SITE_HOST;
  if (!site) return { kind: 'assets' };

  const host = url.hostname;
  const path = normalize(url.pathname);

  if (env.WWW_HOST && host === env.WWW_HOST) {
    return { kind: 'redirect', status: 301, location: `https://${site}${url.pathname}${url.search}` };
  }

  if (host === site) {
    const markdown = MARKDOWN_PAGES[path];
    if (markdown && prefersMarkdown(accept)) return { kind: 'site-markdown', file: markdown };
    if (path === '/') return { kind: 'site-home' };
    if (markdown) return { kind: 'site-page' };
    if (isFilePath(path)) return { kind: 'site-file' };
    if (isSitePath(path)) return { kind: 'assets' };
    return { kind: 'redirect', status: 302, location: `https://${env.APP_HOST}${url.pathname}${url.search}` };
  }

  if (path === '/robots.txt') return { kind: 'robots' };
  return { kind: 'app-assets' };
}

/** Headers on a fetched Response are immutable; copy, then say the URL negotiates. */
function withVary(response) {
  const varied = new Response(response.body, response);
  varied.headers.set('vary', 'Accept');
  return varied;
}

/** The HTML of a page with a markdown twin, with the homepage's Link header on `/`. */
async function htmlPage(request, env, home) {
  const page = withVary(await env.ASSETS.fetch(request));
  if (home) page.headers.set('link', HOMEPAGE_LINKS);
  return page;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const action = decide(url, env, request.headers.get('accept'));

    switch (action.kind) {
      case 'redirect':
        return Response.redirect(action.location, action.status);
      case 'robots':
        return new Response(APP_ROBOTS, {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': ROBOTS_NOINDEX }
        });
      case 'site-home':
      case 'site-page':
        return htmlPage(request, env, action.kind === 'site-home');
      case 'site-markdown': {
        // Method and headers carry over, so HEAD and If-None-Match still work.
        const twin = new Request(new URL(action.file, url), { method: request.method, headers: request.headers });
        const response = await env.ASSETS.fetch(twin);
        if (response.status === 304) return withVary(response);
        // A build without the twin falls back to the page, never a 404.
        if (!response.ok || isSpaFallback(action.file, response)) {
          return htmlPage(request, env, normalize(url.pathname) === '/');
        }
        const text = await response.text();
        const headers = new Headers(response.headers);
        headers.set('content-type', 'text/markdown; charset=utf-8');
        headers.set('vary', 'Accept');
        headers.delete('content-length');
        // An estimate, at four characters a token: enough to size a context
        // window or a chunking strategy, which is what the header is for.
        if (text) headers.set('x-markdown-tokens', String(Math.ceil(text.length / 4)));
        return new Response(request.method === 'HEAD' ? null : text, { status: response.status, headers });
      }
      case 'site-file': {
        const response = await env.ASSETS.fetch(request);
        if (!isSpaFallback(url.pathname, response)) {
          const path = normalize(url.pathname);
          if (!(path in DISCOVERY_TYPES)) return response;
          const shared = new Response(response.body, response);
          shared.headers.set('access-control-allow-origin', '*');
          if (DISCOVERY_TYPES[path]) shared.headers.set('content-type', DISCOVERY_TYPES[path]);
          return shared;
        }
        // A miss. Keep the asset server's headers (the security headers from
        // _headers) and replace the homepage it sent with a plain 404, so a
        // crawler probing /sitemap.xml or /.well-known/* learns the truth.
        const headers = new Headers(response.headers);
        headers.set('content-type', 'text/plain; charset=utf-8');
        headers.set('x-robots-tag', ROBOTS_NOINDEX);
        headers.delete('content-length');
        headers.delete('etag');
        return new Response('Not found\n', { status: 404, headers });
      }
      case 'app-assets': {
        const response = await env.ASSETS.fetch(request);
        // Headers on a fetched Response are immutable; copy before setting.
        const marked = new Response(response.body, response);
        marked.headers.set('x-robots-tag', ROBOTS_NOINDEX);
        return marked;
      }
      default:
        return env.ASSETS.fetch(request);
    }
  }
};
