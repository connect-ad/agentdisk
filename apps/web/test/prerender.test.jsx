// @vitest-environment node
/**
 * The marketing routes render to HTML under Node, with no `window`.
 *
 * This is what `scripts/prerender.mjs` does at build time, run here as a
 * test so that a component which starts reading a browser global at render
 * fails the suite instead of the deploy. The environment is Node on purpose:
 * jsdom would hand every component a `window` and prove nothing.
 */

import { describe, expect, it } from 'vitest';
import { PRERENDERED_ROUTES, CONTENT_META, render } from '../src/entry-prerender.jsx';
import { markdownTwin } from '../worker.js';
import { markdownFileFor, pageMarkdown } from '../scripts/page-markdown.mjs';

const EXPECTED = {
  '/': 'Storage your agents can actually reason about.',
  '/pricing': 'Pay for storage. Nothing else.',
  '/docs': 'AgentDisk documentation',
  // 4 Oct 2026: the trust pages, the blog and the comparison pages.
  '/security': 'Security',
  '/privacy': 'Privacy Policy',
  '/terms': 'Terms of Service',
  '/trust': 'Trust Center',
  '/sub-processors': 'Sub-processors',
  '/blog': 'Blog',
  '/compare/agentdisk-vs-s3': 'AgentDisk vs S3 for AI agents',
  '/alternatives/fast-io': 'Looking for a Fast.io alternative?',
  '/storage-for-cursor': 'File Storage for Cursor',
  '/blog/why-we-built-agentdisk': 'We Built Serverless File Storage for AI Agents'
};

describe('prerender', () => {
  it('covers the public marketing routes', () => {
    for (const route of Object.keys(EXPECTED)) expect(PRERENDERED_ROUTES, route).toContain(route);
  });

  it('renders every prerendered route to a page with a heading, with no window', () => {
    for (const route of PRERENDERED_ROUTES) {
      const html = render(route);
      expect(html, route).toMatch(/<h1[ >]/);
      expect(html.length, route).toBeGreaterThan(4000);
    }
  });

  it('writes FAQPage JSON-LD on every comparison, alternative, agent page and post', () => {
    const faqRoutes = Object.keys(CONTENT_META);
    expect(faqRoutes.length).toBeGreaterThanOrEqual(22);
    for (const route of [...faqRoutes, '/security']) {
      const html = render(route);
      expect(html, route).toContain('"@type":"FAQPage"');
      expect(html.match(/"@type":"Question"/g).length, route).toBeGreaterThanOrEqual(5);
    }
    expect(render('/blog/why-we-built-agentdisk')).toContain('"@type":"BlogPosting"');
  });

  for (const [route, heading] of Object.entries(EXPECTED)) {
    it(`renders ${route} to a page carrying its heading, with no window`, () => {
      expect(typeof window).toBe('undefined');
      const html = render(route);
      expect(html).toContain(heading);
      // A page, not a nav with an empty main.
      expect(html.length).toBeGreaterThan(4000);
    });
  }

  it('renders each route to different content', () => {
    const pages = PRERENDERED_ROUTES.map(render);
    expect(new Set(pages).size).toBe(pages.length);
  });
});

describe('the markdown twin of each page', () => {
  it('is written under the name the Worker serves', () => {
    for (const route of PRERENDERED_ROUTES) {
      expect(`/${markdownFileFor(route)}`, route).toBe(markdownTwin(route));
    }
  });

  for (const [route, heading] of Object.entries(EXPECTED)) {
    it(`converts ${route} to markdown carrying its heading and canonical URL`, () => {
      const md = pageMarkdown(route, render(route), CONTENT_META);
      expect(md.startsWith('---\ntitle: ')).toBe(true);
      expect(md).toContain(`url: https://agentdisk.io${route === '/' ? '/' : route}`);
      expect(md).toContain(`# ${heading}`);
      // Chrome with no content for an agent is dropped, not converted.
      expect(md).not.toMatch(/<svg|<button|<nav/);
    });
  }

  it('keeps the docs tables as tables and separates chip-style spans', () => {
    expect(pageMarkdown('/docs', render('/docs'))).toMatch(/^\| .+ \|$/m);
    const pricing = pageMarkdown('/pricing', render('/pricing'));
    expect(pricing).toContain('1 GB storage · 1 agent identity');
    expect(pricing).not.toMatch(/ · $/m);
  });
});
