/**
 * The long-form site pages added on 4 Oct 2026: the trust pages, the blog,
 * the comparisons and the agent pages.
 *
 * Pinned here: the blog's markdown subset parses as the posts use it; every
 * post meets the linking rules (another post, a product page, a trust page)
 * and ends in five questions; the footer points at the new pages and nothing
 * on the site still links to the old /docs# anchors; and the Security page
 * keeps the claims it must not make out of its text.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/lib/auth.jsx', () => ({
  useAuth: () => ({ user: null, loading: false }),
}));

const { parseFrontmatter, parseBlocks, parseInline, splitFaq } = await import('../src/lib/markdown.js');
const { POSTS, relatedPosts } = await import('../src/lib/blog.js');
const { Footer } = await import('../src/routes/Marketing.jsx');
const { Security, SubProcessors, Dpa, Terms, TrustCenter } = await import('../src/routes/Trust.jsx');

afterEach(cleanup);

const at = (path, ui) => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);

describe('the blog markdown subset', () => {
  it('reads frontmatter strings and arrays', () => {
    const { data, body } = parseFrontmatter('---\ntitle: "A: b"\ntags: [one, two]\ndate: 2026-10-04\n---\n\nHello');
    expect(data).toEqual({ title: 'A: b', tags: ['one', 'two'], date: '2026-10-04' });
    expect(body.trim()).toBe('Hello');
  });

  it('parses headings, lists, code, tables and quotes', () => {
    const blocks = parseBlocks([
      '## Two', '### Three', 'A paragraph', 'that wraps.', '', '- a', '- b', '', '1. one', '2. two', '',
      '```bash', 'echo hi', '```', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', '> quoted',
    ].join('\n'));
    expect(blocks.map(b => b.type)).toEqual(['h2', 'h3', 'p', 'ul', 'ol', 'code', 'table', 'quote']);
    expect(blocks[2].text).toBe('A paragraph that wraps.');
    expect(blocks[5]).toEqual({ type: 'code', lang: 'bash', text: 'echo hi' });
    expect(blocks[6].rows).toEqual([['1', '2']]);
  });

  it('tokenises inline code, bold, emphasis and links, nested', () => {
    const toks = parseInline('a `x` **[b](/c)** *d*');
    expect(toks.map(t => t.t)).toEqual(['text', 'code', 'text', 'strong', 'text', 'em']);
    expect(toks[3].c[0]).toMatchObject({ t: 'link', href: '/c' });
  });

  it('splits the closing FAQ into plain-text questions and answers', () => {
    const { body, faq } = splitFaq(parseBlocks('Intro\n\n## Frequently asked questions\n\n### Q one?\n\nA [link](/x).\n\nMore.'));
    expect(body).toHaveLength(1);
    expect(faq).toEqual([{ q: 'Q one?', a: 'A link.\n\nMore.' }]);
  });
});

describe('the posts', () => {
  const PRODUCT = /\]\((\/pricing|\/docs[^)]*|\/sandbox)\)/;
  const TRUST = /\]\((\/security|\/privacy|\/trust|\/sub-processors|\/terms)\)/;

  it('are all there, newest first', () => {
    expect(POSTS.length).toBe(10);
    const dates = POSTS.map(p => p.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  for (const post of POSTS) {
    it(`${post.slug}: complete frontmatter, five FAQs, and the three kinds of link`, () => {
      expect(post.title).toBeTruthy();
      expect(post.description.length).toBeLessThanOrEqual(160);
      expect(post.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(post.tags.length).toBeGreaterThan(0);
      expect(post.faq).toHaveLength(5);
      for (const { q, a } of post.faq) {
        expect(q.endsWith('?'), q).toBe(true);
        expect(a.length, q).toBeGreaterThan(40);
      }
      const source = readFileSync(resolve(process.cwd(), `src/content/blog/${post.slug}.md`), 'utf8');
      expect(source, 'links another post').toMatch(/\]\(\/blog\/[a-z0-9-]+\)/);
      expect(source, 'links a product page').toMatch(PRODUCT);
      expect(source, 'links a trust page').toMatch(TRUST);
      // The endpoint placeholders were substituted.
      expect(JSON.stringify(post.blocks)).not.toMatch(/\{\{(API_BASE|MCP_ENDPOINT)\}\}/);
      // Every linked post exists.
      for (const m of source.matchAll(/\]\(\/blog\/([a-z0-9-]+)\)/g)) {
        expect(POSTS.some(p => p.slug === m[1]), m[1]).toBe(true);
      }
    });
  }

  it('offers related posts by shared tags, never the post itself', () => {
    const post = POSTS.find(p => p.slug === 'scoped-credentials-ai-agents');
    const related = relatedPosts(post);
    expect(related).toHaveLength(3);
    expect(related.some(p => p.slug === post.slug)).toBe(false);
    expect(related[0].tags.some(t => post.tags.includes(t))).toBe(true);
  });
});

describe('the footer and the old anchors', () => {
  it('links the trust pages, the blog and the comparisons', () => {
    at('/', <Footer />);
    const footer = screen.getByRole('contentinfo');
    const hrefs = within(footer).getAllByRole('link').map(a => a.getAttribute('href'));
    for (const href of ['/security', '/trust', '/privacy', '/terms', '/sub-processors', '/dpa', '/blog',
      '/compare/agentdisk-vs-fast-io', '/compare/agentdisk-vs-s3', '/compare/agentdisk-vs-diskd-ai', '/alternatives']) {
      expect(hrefs, href).toContain(href);
    }
    expect(hrefs.some(h => h.startsWith('/docs#'))).toBe(false);
  });

  it('leaves no link to a moved /docs# anchor anywhere in the source', () => {
    const files = [];
    (function walk(dir) {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(jsx?|md)$/.test(name)) files.push(path);
      }
    })(resolve(process.cwd(), 'src'));
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/["'`(]\/docs#(data-security|safety|privacy|terms)\b/);
    }
  });
});

describe('the security page', () => {
  it('claims no certification of its own and names what is not enabled', () => {
    const { container } = at('/security', <Security />);
    const text = container.textContent;
    expect(text).toMatch(/AgentDisk does not hold its own SOC 2 certification/);
    expect(text).toMatch(/No compliance certification is claimed/);
    expect(text).not.toMatch(/AgentDisk is SOC 2 (compliant|certified)/);
    expect(text).not.toMatch(/OWASP|96\.3%|Cloudflare KV/);
    expect(text).toMatch(/more than 1,000 automated tests/);
    // 4 Oct 2026: no self-declared SOC 2 alignment, and no map of what is
    // switched off or not yet built for an attacker to read.
    expect(text).not.toMatch(/practices align|not switched on for this zone|No per-key rate limit/);
  });

  it('carries the merged sections, the certifications, the criteria table and ten FAQs', () => {
    const { container } = at('/security', <Security />);
    for (const id of ['data-security', 'safety', 'certifications', 'soc2', 'faq']) {
      expect(container.querySelector(`section#${id}, section[aria-labelledby="${id}"]`), id).not.toBeNull();
    }
    const ld = JSON.parse(container.querySelector('script[type="application/ld+json"]').textContent);
    expect(ld['@type']).toBe('FAQPage');
    expect(ld.mainEntity).toHaveLength(10);
  });

  it('lists the same four processors the privacy policy names', () => {
    const { container } = at('/sub-processors', <SubProcessors />);
    const rows = [...container.querySelectorAll('tbody tr')].map(r => r.cells[0].textContent);
    expect(rows).toEqual([
      'Cloudflare, Inc.', 'Google LLC (Firebase Authentication)', 'Stripe, Inc.', 'Google LLC (Google Analytics)',
    ]);
  });
});

describe('the data processing agreement', () => {
  it('names the processor, the transfer clauses and the governing law', () => {
    const { container } = at('/dpa', <Dpa />);
    const text = container.textContent;
    expect(text).toMatch(/Kernelv5 Inc\., a Delaware/);
    expect(text).toMatch(/\(EU\) 2021\/914/);
    expect(text).toMatch(/Module Two/);
    expect(text).toMatch(/International Data Transfer Addendum/);
    expect(text).toMatch(/without undue delay/);
    expect(text).toMatch(/within seven days/);
    expect(text).toMatch(/laws of the State of Delaware/);
  });

  it('is linked from the Trust Center and named by the Terms', () => {
    const hub = at('/trust', <TrustCenter />).container;
    expect([...hub.querySelectorAll('a')].map(a => a.getAttribute('href'))).toContain('/dpa');
    cleanup();
    const terms = at('/terms', <Terms />).container.textContent;
    expect(terms).toMatch(/Data Processing Agreement/);
    expect(terms).toMatch(/laws of the State of Delaware/);
  });

  it('leaves no page saying the entity, the DPA or the governing law is still to come', () => {
    const files = [];
    (function walk(dir) {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(jsx?|md)$/.test(name)) files.push(path);
      }
    })(resolve(process.cwd(), 'src'));
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/operating entity is finalised|not published (a DPA|yet)|DPA has been published|does not publish a data processing agreement/);
    }
  });
});

describe('the comparison pages after the 4 Oct 2026 fact check', () => {
  it('carry no unverified or superseded competitor claim', async () => {
    const { COMPARISONS, ALTERNATIVES } = await import('../src/content/compare.js');
    const text = JSON.stringify([COMPARISONS, ALTERNATIVES]);
    expect(text).not.toMatch(/251 MCP|\$29|3,000|Not covered here|people switch|common pattern|Most teams|practices align/);
    expect(text).toMatch(/\$9\.99/);
    expect(text).toMatch(/1,500\+/);
    for (const a of ALTERNATIVES) expect(a.h1, a.slug).toMatch(/\?$/);
    expect(ALTERNATIVES.find(a => a.slug === 's3-for-agents').h1).toBe('Looking for an S3 alternative?');
  });
});
