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
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

// Signed out by default, as every test below the Support block expects. One
// test flips it, because the Support item must not depend on being signed in.
vi.mock('../src/lib/auth.jsx', () => ({
  useAuth: () => ({ user: globalThis.__navUser ?? null, loading: false }),
}));

const { Nav } = await import('../src/routes/Marketing.jsx');

afterEach(() => { cleanup(); globalThis.__navUser = null; });

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

  /**
   * "Bigger" and "bolder" are comparisons, so the tokens are resolved to their
   * numbers and compared. Asserting the literal `var(--t-14)` would pass just
   * as happily on the day someone redefines --t-14 as smaller than --t-13.
   */
  const tokens = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
  const tokenValue = name => {
    const m = tokens.match(new RegExp(`--${name}:([^;}]+)`));
    expect(m, `--${name} is not defined`).not.toBeNull();
    return parseFloat(m[1]);
  };
  /** The winning value of `prop`, taking the last declaration as CSS does. */
  const declared = (rules, prop) => {
    const found = rules.flatMap(r => [...r.body.matchAll(new RegExp(`${prop}:var\\(--([a-z0-9-]+)\\)`, 'g'))]);
    expect(found.length, `no ${prop} declared`).toBeGreaterThan(0);
    return found[found.length - 1][1];
  };
  const base = () => RULES.filter(r => r.selector === '.mk__navlink');

  it('sets the current label heavier than the rest', () => {
    const on = tokenValue(declared(active, 'font-weight'));
    const off = tokenValue(declared(base(), 'font-weight'));
    expect(on).toBeGreaterThan(off);
    expect(on).toBe(700);
  });

  it('sets the current label larger than the rest, but never larger than the wordmark', () => {
    const on = tokenValue(declared(active, 'font-size'));
    const off = tokenValue(declared(base(), 'font-size'));
    const wordmark = tokenValue(declared(blocksMentioning('.mk__wordmark'), 'font-size'));
    expect(on).toBeGreaterThan(off);
    // The brand stays the biggest thing in the bar.
    expect(on).toBeLessThan(wordmark);
  });

  it('never re-introduces the underline the vendored sheet puts on every link', () => {
    for (const b of blocksMentioning('.mk__navlink')) {
      expect(b.body, `${b.selector} underlines`).not.toContain('text-decoration:underline');
    }
  });
});

/**
 * Support, the fourth item in the row.
 *
 * It is the only thing in the nav that is not a navigation, and both halves of
 * that matter: it must sit where a reader expects the next item, and it must
 * not claim to be a page. The dialog it opens is shared with the cookie
 * notice (components-local/SupportDialog.jsx), so the address exists once.
 */
describe('the Support item', () => {
  const support = () => screen.getByRole('button', { name: 'Support' });

  it('comes immediately after Docs', () => {
    const { docs } = renderAt('/');
    const following = docs.compareDocumentPosition(support()) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(Boolean(following)).toBe(true);
  });

  it('is a button and not a link, because it goes nowhere', () => {
    renderAt('/');
    expect(screen.queryByRole('link', { name: 'Support' })).toBeNull();
    expect(support().getAttribute('type')).toBe('button');
  });

  it('is never the current page, on any page', () => {
    for (const path of ['/', '/pricing', '/docs', '/terms']) {
      renderAt(path);
      expect(support().getAttribute('aria-current')).toBeNull();
      expect(support().classList.contains('mk__navlink--on')).toBe(false);
      cleanup();
    }
  });

  it('is there signed in too, where the right-hand actions change', () => {
    globalThis.__navUser = { uid: 'u_1' };
    renderAt('/');
    // `Button as={Link}` renders an anchor, so this is a link, not a button.
    expect(screen.getByRole('link', { name: 'Open dashboard' })).not.toBeNull();
    expect(support()).not.toBeNull();
  });

  it('opens the dialog, which carries the address and a mailto', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await user.click(support());

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/connect@agentdisk\.io/);
    expect(screen.getByRole('link', { name: /Email connect@agentdisk\.io/ }).getAttribute('href'))
      .toMatch(/^mailto:connect@agentdisk\.io/);
  });

  it('renders the dialog outside the sticky nav, or it could not paint above it', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await user.click(support());

    const nav = document.querySelector('.mk__nav');
    const dialog = screen.getByRole('dialog');
    // .mk__nav is sticky with z-index 30 and is therefore a stacking context.
    // A scrim inside it is capped by that context whatever its own z-index --
    // the trap docs/ui-layering.md §1 records against .wsx__menu.
    expect(nav.contains(dialog)).toBe(false);
  });

  it('closes again without navigating', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await user.click(support());
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('wears the link styling with the button chrome removed', () => {
    const action = blocksMentioning('.mk__navlink--action');
    expect(action.length, 'no rule for the Support item').toBeGreaterThan(0);
    const body = action.map(b => b.body).join(';');
    // A UA button background under a nav link reads as a broken control.
    expect(body).toContain('background:none');
    expect(body).toContain('cursor:pointer');
  });
});
