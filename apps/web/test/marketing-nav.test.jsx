/**
 * The marketing nav says which page you are on.
 *
 * Product, Pricing and Docs used to be three identical accent-coloured links,
 * so nothing told you which one you were reading and clicking it again did
 * nothing visible. NavLink now marks the current one with `aria-current="page"`
 * and the `mk__navlink--on` class, which `app.css` draws as the accent colour
 * plus a bar. These tests pin the routing half: the class and the attribute
 * land on exactly one link, and on the right one.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

vi.mock('../src/lib/auth.jsx', () => ({
  useAuth: () => ({ user: null, loading: false }),
}));

const { Nav } = await import('../src/routes/Marketing.jsx');

afterEach(cleanup);

function renderAt(path) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Nav />
    </MemoryRouter>
  );
  return {
    product: screen.getByRole('link', { name: 'Product' }),
    pricing: screen.getByRole('link', { name: 'Pricing' }),
    docs: screen.getByRole('link', { name: 'Docs' }),
  };
}

const isOn = el =>
  el.getAttribute('aria-current') === 'page' && el.classList.contains('mk__navlink--on');

describe('marketing nav current-page state', () => {
  it('marks Product, and only Product, on the landing page', () => {
    const { product, pricing, docs } = renderAt('/');
    expect(isOn(product)).toBe(true);
    expect(isOn(pricing)).toBe(false);
    expect(isOn(docs)).toBe(false);
  });

  it('marks Pricing on /pricing and leaves Product alone', () => {
    const { product, pricing, docs } = renderAt('/pricing');
    expect(isOn(pricing)).toBe(true);
    expect(isOn(product)).toBe(false);
    expect(isOn(docs)).toBe(false);
  });

  it('keeps Docs current for a nested docs path', () => {
    const { product, pricing, docs } = renderAt('/docs/quickstart');
    expect(isOn(docs)).toBe(true);
    expect(isOn(product)).toBe(false);
    expect(isOn(pricing)).toBe(false);
  });

  it('marks nothing on a page that is not one of the three', () => {
    const { product, pricing, docs } = renderAt('/terms');
    expect([product, pricing, docs].some(isOn)).toBe(false);
  });

  it('gives every page link the shared class, so none can fall back to the underlined default', () => {
    const { product, pricing, docs } = renderAt('/');
    for (const el of [product, pricing, docs]) {
      expect(el.classList.contains('mk__navlink')).toBe(true);
    }
    expect(screen.getByRole('link', { name: 'Sign in' }).classList.contains('mk__navlink')).toBe(true);
  });
});

/**
 * The styling half, asserted against the stylesheet as text. jsdom computes no
 * cascade and lays nothing out, so a rendering test cannot tell a pill from a
 * word in a different colour — and that difference is the entire requirement.
 */
const css = readFileSync(resolve(process.cwd(), 'src/app.css'), 'utf8');

/**
 * Every `selector{...}` pair in the sheet, as {selector, body}. Parsed by
 * splitting rather than by regex: the selectors here contain `.` and `--`, and
 * a pattern built from them by interpolation is one escaping mistake away from
 * matching nothing and passing silently.
 */
const RULES = css
  .replace(/\/\*[\s\S]*?\*\//g, '') // or every selector carries its comment
  .split('}')
  .map(chunk => {
    const at = chunk.indexOf('{');
    if (at === -1) return null;
    return { selector: chunk.slice(0, at).trim(), body: chunk.slice(at + 1) };
  })
  .filter(Boolean);

/** Every declaration block whose selector list mentions `selector`. */
const blocksMentioning = selector => RULES.filter(r => r.selector.includes(selector));

describe('the current page is drawn as a shape, not only a colour', () => {
  const active = blocksMentioning('.mk__navlink--on');

  it('fills the current link and gives it a border', () => {
    const pill = active.filter(b => b.body.includes('background-color'));
    expect(pill.length, 'no filled rule for the current link').toBeGreaterThan(0);
    const body = pill.map(b => b.body).join(';');
    expect(body).toContain('background-color:var(--accent-soft)');
    expect(body).toContain('border-color:color-mix(in srgb,var(--accent) 38%,transparent)');
  });

  it('reserves that border on every link, so gaining it shifts no layout', () => {
    const base = blocksMentioning('.mk__navlink').find(b => b.selector === '.mk__navlink');
    expect(base, 'no base .mk__navlink rule').toBeDefined();
    expect(base.body).toContain('border:1px solid transparent');
  });

  it('animates the pill in, with the keyframes it names', () => {
    const anim = active.map(b => b.body).join(';').match(/animation:([a-z-]+)/);
    expect(anim, 'the current link has no entrance animation').not.toBeNull();
    expect(css).toContain(`@keyframes ${anim[1]}`);
  });

  it('never re-introduces the underline the vendored sheet puts on every link', () => {
    for (const b of blocksMentioning('.mk__navlink')) {
      expect(b.body, `${b.selector} underlines`).not.toContain('text-decoration:underline');
    }
  });
});
