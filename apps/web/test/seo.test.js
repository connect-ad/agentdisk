/**
 * Page metadata: the table, the prerendered head, and the live update.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_META,
  PAGE_META,
  SITE_ORIGIN,
  applyPageMeta,
  headTags,
  metaFor
} from '../src/lib/seo.js';
import { PRERENDERED_ROUTES } from '../src/entry-prerender.jsx';

describe('the metadata table', () => {
  it('covers every prerendered route, and only those', () => {
    expect(Object.keys(PAGE_META).sort()).toEqual([...PRERENDERED_ROUTES].sort());
  });

  it('keeps titles and descriptions inside what a search result shows', () => {
    for (const [route, meta] of Object.entries({ ...PAGE_META, default: DEFAULT_META })) {
      expect(meta.title.length, `${route} title`).toBeLessThanOrEqual(70);
      expect(meta.description.length, `${route} description`).toBeGreaterThanOrEqual(60);
      expect(meta.description.length, `${route} description`).toBeLessThanOrEqual(170);
    }
  });

  it('gives every route a different title', () => {
    const titles = Object.values(PAGE_META).map(m => m.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('falls back to the default for anything unlisted, ignoring a trailing slash', () => {
    expect(metaFor('/pricing/')).toBe(PAGE_META['/pricing']);
    expect(metaFor('/w/acme/files')).toBe(DEFAULT_META);
    expect(metaFor(undefined)).toBe(PAGE_META['/']);
  });
});

describe('headTags', () => {
  for (const route of PRERENDERED_ROUTES) {
    it(`writes a title, description, canonical and social tags for ${route}`, () => {
      const head = headTags(route);
      const meta = PAGE_META[route];
      expect(head).toContain(`<title>${meta.title.replace(/&/g, '&amp;')}</title>`);
      expect(head).toContain(`<meta name="description" content="${meta.description}"`);
      expect(head).toContain(`<link rel="canonical" href="${SITE_ORIGIN}${route}"`);
      expect(head).toContain(`<meta property="og:url" content="${SITE_ORIGIN}${route}"`);
      expect(head).toContain('<meta name="twitter:card" content="summary"');
    });
  }

  it('puts the product schema on the homepage only', () => {
    expect(headTags('/')).toContain('application/ld+json');
    expect(headTags('/')).toContain('"@type":"SoftwareApplication"');
    expect(headTags('/pricing')).not.toContain('application/ld+json');
  });

  it('escapes what it interpolates', () => {
    // The table holds no markup today; this pins that the function would cope.
    const head = headTags('/');
    expect(head).not.toMatch(/content="[^"]*<[^"]*"/);
  });
});

describe('applyPageMeta', () => {
  it('updates the live head in place rather than adding a second set of tags', () => {
    document.head.innerHTML = '<title>AgentDisk</title>';
    applyPageMeta('/pricing');
    expect(document.title).toBe(PAGE_META['/pricing'].title);
    expect(document.head.querySelector('meta[name="description"]').content).toBe(
      PAGE_META['/pricing'].description
    );
    expect(document.head.querySelector('link[rel="canonical"]').href).toBe(`${SITE_ORIGIN}/pricing`);

    applyPageMeta('/docs');
    expect(document.title).toBe(PAGE_META['/docs'].title);
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
  });

  it('gives a dashboard route the default title, not the homepage headline', () => {
    applyPageMeta('/w/acme/files');
    expect(document.title).toBe(DEFAULT_META.title);
    expect(document.head.querySelector('link[rel="canonical"]').href).toBe(`${SITE_ORIGIN}/`);
  });
});

describe('the sitemap', () => {
  it('lists exactly the prerendered routes, at production URLs', async () => {
    const { PRERENDERED_ROUTES, renderSitemapFile } = await import('../src/lib/seo.js');
    const xml = renderSitemapFile();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    expect(locs).toEqual(PRERENDERED_ROUTES.map(route => `https://agentdisk.io${route}`));
  });

  it('is the same list the prerender renders', async () => {
    // One list, not two that must agree: a route whose canonical points at /
    // must never appear in the sitemap.
    const seo = await import('../src/lib/seo.js');
    expect(seo.PRERENDERED_ROUTES).toEqual(['/', '/pricing', '/docs']);
  });
});
