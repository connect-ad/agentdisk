/**
 * Page metadata: the table, the prerendered head, and the live update.
 *
 * Since 4 Oct 2026 there are two sources: lib/seo.js for the hand-written
 * pages, and lib/pages.js for the pages whose metadata sits beside their
 * content (blog posts, comparisons, alternatives, agent pages). Every check
 * below runs over both.
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
import { PRERENDERED_ROUTES, sitemapFile } from '../src/entry-prerender.jsx';
import { CONTENT_META } from '../src/lib/pages.js';
import { POSTS } from '../src/lib/blog.js';

const ALL_META = { ...PAGE_META, ...CONTENT_META };

describe('the metadata table', () => {
  it('covers every prerendered route, and only those', () => {
    expect(Object.keys(ALL_META).sort()).toEqual([...PRERENDERED_ROUTES].sort());
  });

  it('has no route in both tables', () => {
    for (const route of Object.keys(CONTENT_META)) expect(PAGE_META[route], route).toBeUndefined();
  });

  it('keeps titles and descriptions inside what a search result shows', () => {
    for (const [route, meta] of Object.entries({ ...ALL_META, default: DEFAULT_META })) {
      expect(meta.title.length, `${route} title`).toBeLessThanOrEqual(70);
      expect(meta.description.length, `${route} description`).toBeGreaterThanOrEqual(60);
      expect(meta.description.length, `${route} description`).toBeLessThanOrEqual(170);
    }
  });

  it('gives every route a different title', () => {
    const titles = Object.values(ALL_META).map(m => m.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('falls back to the default for anything unlisted, ignoring a trailing slash', () => {
    expect(metaFor('/pricing/')).toBe(PAGE_META['/pricing']);
    expect(metaFor('/w/acme/files')).toBe(DEFAULT_META);
    expect(metaFor(undefined)).toBe(PAGE_META['/']);
    expect(metaFor('/blog/why-we-built-agentdisk/', CONTENT_META)).toBe(CONTENT_META['/blog/why-we-built-agentdisk']);
  });
});

describe('headTags', () => {
  for (const route of PRERENDERED_ROUTES) {
    it(`writes a title, description, canonical and social tags for ${route}`, () => {
      const head = headTags(route, CONTENT_META);
      const meta = ALL_META[route];
      const esc = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      expect(head).toContain(`<title>${esc(meta.title)}</title>`);
      expect(head).toContain(`<meta name="description" content="${esc(meta.description)}"`);
      expect(head).toContain(`<link rel="canonical" href="${SITE_ORIGIN}${route}"`);
      expect(head).toContain(`<meta property="og:url" content="${SITE_ORIGIN}${route}"`);
      expect(head).toContain('<meta name="twitter:card" content="summary"');
    });
  }

  it('marks a blog post as an article with its date', () => {
    const post = POSTS[0];
    const head = headTags(`/blog/${post.slug}`, CONTENT_META);
    expect(head).toContain('<meta property="og:type" content="article"');
    expect(head).toContain(`<meta property="article:published_time" content="${post.date}"`);
    expect(headTags('/security')).toContain('<meta property="og:type" content="website"');
  });

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

  it('gives a content page its own title and canonical', () => {
    applyPageMeta('/compare/agentdisk-vs-s3', CONTENT_META);
    expect(document.title).toBe(CONTENT_META['/compare/agentdisk-vs-s3'].title);
    expect(document.head.querySelector('link[rel="canonical"]').href)
      .toBe(`${SITE_ORIGIN}/compare/agentdisk-vs-s3`);
  });

  it('gives a dashboard route the default title, not the homepage headline', () => {
    applyPageMeta('/w/acme/files', CONTENT_META);
    expect(document.title).toBe(DEFAULT_META.title);
    expect(document.head.querySelector('link[rel="canonical"]').href).toBe(`${SITE_ORIGIN}/`);
  });
});

describe('the sitemap', () => {
  it('lists exactly the prerendered routes, at production URLs', () => {
    const xml = sitemapFile();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    expect(locs).toEqual(PRERENDERED_ROUTES.map(route => `https://agentdisk.io${route}`));
  });

  it('includes every trust page, index, comparison, agent page and blog post', () => {
    const xml = sitemapFile();
    for (const path of ['/security', '/privacy', '/terms', '/trust', '/sub-processors', '/dpa', '/blog',
      '/compare', '/alternatives', '/compare/agentdisk-vs-s3', '/alternatives/fast-io', '/storage-for-cline']) {
      expect(xml, path).toContain(`<loc>https://agentdisk.io${path}</loc>`);
    }
    for (const post of POSTS) expect(xml).toContain(`<loc>https://agentdisk.io/blog/${post.slug}</loc>`);
    expect(POSTS.length).toBeGreaterThanOrEqual(10);
  });

  it('starts with the hand-written pages, the same list lib/seo.js names', async () => {
    // One list, not two that must agree: a route whose canonical points at /
    // must never appear in the sitemap.
    const seo = await import('../src/lib/seo.js');
    expect(seo.PRERENDERED_ROUTES).toEqual(Object.keys(PAGE_META));
    expect(PRERENDERED_ROUTES.slice(0, seo.PRERENDERED_ROUTES.length)).toEqual(seo.PRERENDERED_ROUTES);
  });
});
