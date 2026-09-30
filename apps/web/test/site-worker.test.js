/**
 * The Worker that splits one deploy into a marketing site and an app, by
 * hostname. See worker.js's header for the rules; each rule has a case here.
 */
import { describe, expect, it } from 'vitest';
import worker, { decide, isSitePath } from '../worker.js';

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
    expect(decide(at('dev.agentdisk.io', '/'), env)).toEqual({ kind: 'assets' });
    expect(decide(at('dev.agentdisk.io', '/docs/api'), env)).toEqual({ kind: 'assets' });
    expect(decide(at('dev.agentdisk.io', '/assets/index-x.js'), env)).toEqual({ kind: 'assets' });
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
