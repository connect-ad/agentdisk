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
  if (/\.[a-z0-9]+$/i.test(path)) return true;
  return false;
}

/**
 * What to do with a request, as data. Pure, so the test can assert every
 * branch without a fetch.
 *
 * Returns one of:
 *   { kind: 'assets' }       serve from the assets as-is
 *   { kind: 'app-assets' }   serve from the assets, marked noindex
 *   { kind: 'robots' }       the app host's own robots.txt
 *   { kind: 'redirect', status, location }
 */
export function decide(url, env) {
  const site = env.SITE_HOST;
  if (!site) return { kind: 'assets' };

  const host = url.hostname;
  const path = normalize(url.pathname);

  if (env.WWW_HOST && host === env.WWW_HOST) {
    return { kind: 'redirect', status: 301, location: `https://${site}${url.pathname}${url.search}` };
  }

  if (host === site) {
    if (isSitePath(path)) return { kind: 'assets' };
    return { kind: 'redirect', status: 302, location: `https://${env.APP_HOST}${url.pathname}${url.search}` };
  }

  if (path === '/robots.txt') return { kind: 'robots' };
  return { kind: 'app-assets' };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const action = decide(url, env);

    switch (action.kind) {
      case 'redirect':
        return Response.redirect(action.location, action.status);
      case 'robots':
        return new Response(APP_ROBOTS, {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': ROBOTS_NOINDEX }
        });
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
