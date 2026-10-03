/**
 * The Worker that splits one deploy into a marketing site and an app, by
 * hostname. See worker.js's header for the rules; each rule has a case here.
 */
import { describe, expect, it } from 'vitest';
import worker, { HOMEPAGE_LINKS, decide, isFilePath, isSitePath, prefersMarkdown } from '../worker.js';

const env = {
  SITE_HOST: 'dev.agentdisk.io',
  APP_HOST: 'app-dev.agentdisk.io',
  WWW_HOST: 'www.agentdisk.io',
  ASSETS: {
    fetch: async request =>
      new Response(`asset:${new URL(request.url).pathname}`, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' }
      })
  }
};

const at = (host, path) => new URL(`https://${host}${path}`);

describe('isSitePath', () => {
  it('accepts the marketing routes, with or without a trailing slash', () => {
    for (const p of ['/', '/pricing', '/pricing/', '/docs', '/docs/quick-start', '/sandbox', '/terms', '/privacy']) {
      expect(isSitePath(p), p).toBe(true);
    }
  });
  it('accepts files and hashed bundles, which the pages need', () => {
    for (const p of ['/assets/index-abc123.js', '/robots.txt', '/llms.txt', '/agentdisk-logo.png', '/prerender-guard.js', '/pricing.html']) {
      expect(isSitePath(p), p).toBe(true);
    }
  });
  it('refuses everything that belongs to the app', () => {
    for (const p of ['/login', '/signup', '/app', '/w/acme/files', '/claim/abc', '/s/abc', '/account/profile', '/500', '/nonsense']) {
      expect(isSitePath(p), p).toBe(false);
    }
  });
});

describe('decide', () => {
  it('serves marketing routes on the site host', () => {
    expect(decide(at('dev.agentdisk.io', '/'), env)).toEqual({ kind: 'site-home' });
    expect(decide(at('dev.agentdisk.io', '/docs/api'), env)).toEqual({ kind: 'assets' });
    expect(decide(at('dev.agentdisk.io', '/assets/index-x.js'), env)).toEqual({ kind: 'site-file' });
    expect(decide(at('dev.agentdisk.io', '/.well-known/api-catalog'), env)).toEqual({ kind: 'site-file' });
  });

  it('sends app paths on the site host to the app host, keeping path and query', () => {
    expect(decide(at('dev.agentdisk.io', '/login?next=%2Fapp'), env)).toEqual({
      kind: 'redirect',
      status: 302,
      location: 'https://app-dev.agentdisk.io/login?next=%2Fapp'
    });
    expect(decide(at('dev.agentdisk.io', '/w/acme/files'), env).location).toBe('https://app-dev.agentdisk.io/w/acme/files');
  });

  it('moves www permanently to the site', () => {
    expect(decide(at('www.agentdisk.io', '/pricing?x=1'), env)).toEqual({
      kind: 'redirect',
      status: 301,
      location: 'https://dev.agentdisk.io/pricing?x=1'
    });
  });

  it('serves everything on the app host, marked as app content', () => {
    expect(decide(at('app-dev.agentdisk.io', '/'), env)).toEqual({ kind: 'app-assets' });
    expect(decide(at('app-dev.agentdisk.io', '/login'), env)).toEqual({ kind: 'app-assets' });
    expect(decide(at('app-dev.agentdisk.io', '/pricing'), env)).toEqual({ kind: 'app-assets' });
  });

  it('answers robots.txt itself on the app host', () => {
    expect(decide(at('app-dev.agentdisk.io', '/robots.txt'), env)).toEqual({ kind: 'robots' });
  });

  it('does nothing at all when no site host is configured', () => {
    const single = { ASSETS: env.ASSETS };
    expect(decide(at('localhost', '/login'), single)).toEqual({ kind: 'assets' });
    expect(decide(at('www.agentdisk.io', '/'), single)).toEqual({ kind: 'assets' });
    expect(decide(at('localhost', '/robots.txt'), single)).toEqual({ kind: 'assets' });
  });

  it('treats an unknown host as the app, never as the site', () => {
    expect(decide(at('agentdisk-dev-web.example.workers.dev', '/'), env)).toEqual({ kind: 'app-assets' });
  });
});

describe('fetch', () => {
  it('redirects with a Location header', async () => {
    const res = await worker.fetch(new Request('https://dev.agentdisk.io/signup'), env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://app-dev.agentdisk.io/signup');
  });

  it('passes site requests through to the assets untouched', async () => {
    const res = await worker.fetch(new Request('https://dev.agentdisk.io/pricing'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset:/pricing');
    expect(res.headers.get('x-robots-tag')).toBeNull();
    // The asset server's own headers (from dist/_headers) survive.
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('serves the app with a noindex header added and the asset headers kept', async () => {
    const res = await worker.fetch(new Request('https://app-dev.agentdisk.io/w/acme/files'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset:/w/acme/files');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('answers the app host robots.txt with Disallow', async () => {
    const res = await worker.fetch(new Request('https://app-dev.agentdisk.io/robots.txt'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('User-agent: *\nDisallow: /\n');
  });

  it('is a plain pass-through in single-host mode', async () => {
    const res = await worker.fetch(new Request('http://localhost:8787/login'), { ASSETS: env.ASSETS });
    expect(await res.text()).toBe('asset:/login');
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });
});

/* ------------------------- files on the site host ------------------------- */

// An asset server that knows three files and answers everything else the way
// not_found_handling = "single-page-application" does: index.html, 200.
const filesEnv = {
  ...env,
  ASSETS: {
    fetch: async request => {
      const path = new URL(request.url).pathname;
      const files = {
        '/robots.txt': ['User-agent: *\n', 'text/plain'],
        '/sitemap.xml': ['<?xml version="1.0"?>', 'application/xml'],
        '/pricing.html': ['<html>pricing</html>', 'text/html; charset=utf-8']
      };
      const [body, type] = files[path] ?? ['<!doctype html><title>home</title>', 'text/html; charset=utf-8'];
      return new Response(body, {
        status: 200,
        headers: { 'content-type': type, 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'" }
      });
    }
  }
};

describe('isFilePath', () => {
  it('names files, bundles and well-known paths, never pages', () => {
    for (const p of ['/sitemap.xml', '/auth.md', '/assets/x.js', '/.well-known/api-catalog', '/.well-known/mcp.json']) {
      expect(isFilePath(p), p).toBe(true);
    }
    for (const p of ['/', '/pricing', '/docs/quickstart', '/login']) {
      expect(isFilePath(p), p).toBe(false);
    }
  });
});

describe('a missing file on the site host', () => {
  it('answers 404, not the homepage, and keeps the security headers', async () => {
    for (const path of ['/llms-full.txt', '/.well-known/security.txt', '/.well-known/api-catalog', '/assets/gone.js', '/nope.json']) {
      const res = await worker.fetch(new Request(`https://dev.agentdisk.io${path}`), filesEnv);
      expect(`${path} ${res.status}`).toBe(`${path} 404`);
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
    }
  });

  it('serves a file that exists, whatever its type, including a real .html file', async () => {
    for (const [path, status] of [['/robots.txt', 200], ['/sitemap.xml', 200], ['/pricing.html', 200]]) {
      const res = await worker.fetch(new Request(`https://dev.agentdisk.io${path}`), filesEnv);
      expect(`${path} ${res.status}`).toBe(`${path} ${status}`);
    }
  });

  it('keeps .well-known on the site instead of redirecting it to the app', () => {
    expect(isSitePath('/.well-known/oauth-authorization-server')).toBe(true);
  });

  it('leaves the app host alone, where a deep link may end in a file name', async () => {
    const res = await worker.fetch(new Request('https://app-dev.agentdisk.io/w/acme/files/report.pdf'), filesEnv);
    expect(res.status).toBe(200);
  });
});

describe('the homepage Link header', () => {
  it('names llms.txt and the docs on the site root', async () => {
    const res = await worker.fetch(new Request('https://dev.agentdisk.io/'), filesEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get('link')).toBe(HOMEPAGE_LINKS);
    expect(HOMEPAGE_LINKS).toContain('</llms.txt>; rel="describedby"');
    expect(HOMEPAGE_LINKS).toContain('</docs>; rel="service-doc"');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('is not added to other pages or to the app host', async () => {
    const pricing = await worker.fetch(new Request('https://dev.agentdisk.io/pricing'), filesEnv);
    expect(pricing.headers.get('link')).toBeNull();
    const app = await worker.fetch(new Request('https://app-dev.agentdisk.io/'), filesEnv);
    expect(app.headers.get('link')).toBeNull();
  });
});

/* ------------------------- markdown for agents ------------------------- */

// An asset server holding the HTML pages and their markdown twins.
const mdEnv = {
  ...env,
  ASSETS: {
    fetch: async request => {
      const path = new URL(request.url).pathname;
      const files = {
        '/index.md': ['---\ntitle: "AgentDisk"\n---\n\n# Home\n', 'text/markdown'],
        '/pricing.md': ['# Pricing\n', 'text/markdown'],
        '/docs.md': ['# Docs\n', 'text/markdown'],
        '/pricing': ['<html>pricing</html>', 'text/html; charset=utf-8']
      };
      const [body, type] = files[path] ?? ['<!doctype html><title>home</title>', 'text/html; charset=utf-8'];
      return new Response(body, { status: 200, headers: { 'content-type': type, 'x-frame-options': 'DENY' } });
    }
  }
};
const get = (path, accept, host = 'dev.agentdisk.io') =>
  worker.fetch(new Request(`https://${host}${path}`, accept ? { headers: { accept } } : {}), mdEnv);

describe('prefersMarkdown', () => {
  it('is true for an agent that names text/markdown', () => {
    for (const a of ['text/markdown', 'text/markdown, text/html;q=0.9', 'text/html;q=0.5, text/markdown', 'text/markdown, */*']) {
      expect(prefersMarkdown(a), a).toBe(true);
    }
  });
  it('is false for a browser, for */*, and when HTML is preferred', () => {
    for (const a of [
      '',
      null,
      '*/*',
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'text/html, text/markdown;q=0.5',
      'text/markdown;q=0'
    ]) {
      expect(prefersMarkdown(a), String(a)).toBe(false);
    }
  });
});

describe('content negotiation on the site pages', () => {
  it('answers markdown, with its content type, Vary and a token estimate', async () => {
    for (const [path, body] of [['/', '# Home'], ['/pricing', '# Pricing'], ['/docs/', '# Docs']]) {
      const res = await get(path, 'text/markdown');
      expect(`${path} ${res.status}`).toBe(`${path} 200`);
      expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(res.headers.get('vary')).toBe('Accept');
      expect(Number(res.headers.get('x-markdown-tokens'))).toBeGreaterThan(0);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(await res.text()).toContain(body);
    }
  });

  it('keeps HTML the default, and says the URL varies by Accept', async () => {
    const home = await get('/', 'text/html,*/*;q=0.8');
    expect(home.headers.get('content-type')).toContain('text/html');
    expect(home.headers.get('vary')).toBe('Accept');
    expect(home.headers.get('link')).toBe(HOMEPAGE_LINKS);
    const pricing = await get('/pricing');
    expect(await pricing.text()).toBe('<html>pricing</html>');
    expect(pricing.headers.get('vary')).toBe('Accept');
  });

  it('serves HTML when the build has no markdown twin', async () => {
    const bare = { ...env };
    const res = await worker.fetch(new Request('https://dev.agentdisk.io/pricing', { headers: { accept: 'text/markdown' } }), bare);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('touches nothing else: other site paths, the app host, single-host mode', async () => {
    expect(decide(at('dev.agentdisk.io', '/sandbox'), env, 'text/markdown')).toEqual({ kind: 'assets' });
    expect(decide(at('app-dev.agentdisk.io', '/pricing'), env, 'text/markdown')).toEqual({ kind: 'app-assets' });
    expect(decide(at('localhost', '/'), { ASSETS: env.ASSETS }, 'text/markdown')).toEqual({ kind: 'assets' });
    const app = await get('/pricing', 'text/markdown', 'app-dev.agentdisk.io');
    expect(app.headers.get('content-type')).toContain('text/html');
  });
});
