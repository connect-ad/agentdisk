/**
 * The responsive pass (26 Sept 2026).
 *
 * Layout is verified by rendering every route at every viewport in a real
 * Chrome — `harness/audit.mjs` and `harness/interact.mjs`, which jsdom cannot
 * stand in for. What is pinned here is the part that lives in markup and in
 * the stylesheet's wording: the phone nav opens and closes, the docs carry a
 * table of contents that is in the page whatever the width, and the rules
 * that stop desktop being touched — every responsive rule sits under a
 * max-width query — are still true. The stylesheet assertions are text
 * assertions for the same reason `site-sheet.test.js` gives: the thing being
 * protected is the sheet's wording, and a cascade jsdom does not compute
 * cannot say whether desktop lost a rule.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/lib/auth.jsx', () => ({
  useAuth: () => ({ user: null, loading: false }),
}));

const { Nav } = await import('../src/routes/Marketing.jsx');
const Docs = (await import('../src/routes/Docs.jsx')).default;

afterEach(cleanup);

const css = readFileSync(resolve(process.cwd(), 'src/app.css'), 'utf8');
// From the opening of the block's own header comment, so that comment is
// stripped with the rest below rather than read as a rule.
const pass = css.slice(css.lastIndexOf('/*', css.indexOf('Responsive pass (26 Sept 2026)')));

describe('the marketing nav on a phone', () => {
  it('has one button that opens and closes the links, and says which it will do', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/']}><Nav /></MemoryRouter>);

    const burger = screen.getByRole('button', { name: 'Open menu' });
    expect(burger.getAttribute('aria-expanded')).toBe('false');
    expect(burger.getAttribute('aria-controls')).toBe('mk-navlinks');
    expect(document.getElementById('mk-navlinks')).not.toBeNull();

    await user.click(burger);
    expect(burger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Close menu' })).toBe(burger);
    expect(document.querySelector('.mk__nav').classList.contains('is-open')).toBe(true);

    await user.keyboard('{Escape}');
    expect(burger.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.mk__nav').classList.contains('is-open')).toBe(false);
  });

  it('keeps the same links in the panel — it is a layout of the row, not a second nav', () => {
    render(<MemoryRouter initialEntries={['/']}><Nav /></MemoryRouter>);
    const panel = document.getElementById('mk-navlinks');
    for (const name of ['Product', 'Pricing', 'Docs', 'Sign in', 'Start free']) {
      expect(panel.contains(screen.getByRole('link', { name }))).toBe(true);
    }
    expect(panel.contains(screen.getByRole('button', { name: 'Support' }))).toBe(true);
  });
});

describe('the docs table of contents on a phone', () => {
  it('lists every section, folded shut, above the article', () => {
    render(<MemoryRouter initialEntries={['/docs']}><Docs /></MemoryRouter>);
    const mobile = document.querySelector('details.doc__mtoc');
    expect(mobile).not.toBeNull();
    expect(mobile.open).toBe(false);
    const sidebar = document.querySelector('aside.doc__toc');
    const inSidebar = [...sidebar.querySelectorAll('a')].map(a => a.getAttribute('href'));
    const inMobile = [...mobile.querySelectorAll('a')].map(a => a.getAttribute('href'));
    expect(inMobile).toEqual(inSidebar);
    expect(inMobile.length).toBeGreaterThan(5);
  });
});

describe('the stylesheet leaves desktop alone', () => {
  it('states the phone nav, the docs contents and every tightening under a max-width query', () => {
    // Strip the query blocks; whatever is left at the top level must only be
    // a rule that has no effect until something is narrower than its content.
    const topLevel = pass
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    // Rule by rule: with the query blocks gone nothing left nests, so each
    // selector is whatever sits between the previous close brace and the next
    // open one — a multi-line declaration cannot be mistaken for a selector.
    const selectors = [...topLevel.matchAll(/([^{}]+)\{[^{}]*\}/g)].map(m => m[1].trim());
    const allowed = [
      '.select', '.select__el', '.tbl-scroll', '.doc__tablewrap', '.tbl__num', '.actrow p',
      '.actrow code.inline', '.dl dd', '.mk__burger', '.mk__navactions', '.doc__mtoc',
    ];
    for (const s of selectors) expect(allowed, `top-level rule for ${s}`).toContain(s);
    expect(topLevel).toMatch(/\.mk__burger\{display:none\}/);
    expect(topLevel).toMatch(/\.doc__mtoc\{display:none\}/);
    expect(topLevel).toMatch(/\.mk__navactions\{display:contents\}/);
  });

  it('uses only the breakpoints the file already had, plus the two it names', () => {
    const widths = [...pass.matchAll(/@media \(max-width:(\d+)px\)/g)].map(m => Number(m[1]));
    expect(new Set(widths)).toEqual(new Set([875, 600, 560, 400]));
    expect(pass).not.toMatch(/@media \(min-width/);
  });
});
