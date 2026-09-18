/**
 * The public pricing page against the limits the API enforces.
 *
 * This page had drifted from `plans.ts` in three directions at once: it showed
 * three tiers when the catalogue had four, offered 2 GB free where the upload
 * path allowed 1, and advertised a 100,000 requests/month cap that nothing has
 * ever metered. None of those is visible from inside `apps/web` — the numbers
 * look internally consistent, and only the other app says they are wrong.
 *
 * So the assertions here compare the marketing copy against
 * `apps/api/src/lib/plans.ts` itself, read as text. Importing it would mean
 * pulling a Worker module into a jsdom suite; the numbers are what matter and
 * they are right there in the source. A test that only checked `pricing.js`
 * against itself would have passed on every day this page was wrong.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

/* Signed out, which is who reads a pricing page. The nav renders Log in /
   Sign up rather than a workspace link, and nothing on the page is gated. */
vi.mock('../src/lib/auth.jsx', () => ({
  useAuth: () => ({ user: null, loading: false }),
}));

const { Pricing } = await import('../src/routes/Marketing.jsx');
const { PLANS, OVERAGES, FREE_SUMMARY } = await import('../src/lib/pricing.js');

const plansTs = readFileSync(
  resolve(process.cwd(), '../api/src/lib/plans.ts'),
  'utf8'
);

/**
 * One plan's literal limits out of `PLAN_LIMITS`. The block is matched by name
 * so a reordering of the record cannot quietly read the wrong tier's numbers.
 */
function limitsOf(plan) {
  const start = plansTs.indexOf(`  ${plan}: {`);
  expect(start, `${plan} is missing from PLAN_LIMITS`).toBeGreaterThan(-1);
  const block = plansTs.slice(start, plansTs.indexOf('  },', start));
  const field = name => {
    const m = block.match(new RegExp(`${name}:\\s*([^,]+),`));
    expect(m, `${plan}.${name}`).not.toBeNull();
    return m[1].trim();
  };
  return { field, block };
}

/** `50 * GB` → "50 GB", `100 * MB` → "100 MB". */
function sizeLabel(expr) {
  const m = expr.match(/^(\d+)\s*\*\s*(GB|MB)$/);
  expect(m, `unreadable size ${expr}`).not.toBeNull();
  return `${m[1]} ${m[2]}`;
}

/* No `globals: true` in this project's vitest config, so nothing unmounts the
   previous render on its own and a second one would double every query. */
afterEach(cleanup);

const mount = () =>
  render(
    <MemoryRouter initialEntries={['/pricing']}>
      <Pricing />
    </MemoryRouter>
  );

describe('pricing page → the plans the API actually enforces', () => {
  it('offers every plan in PLAN_LIMITS, in the same order', () => {
    const order = [...plansTs.matchAll(/^ {2}(free|basic|pro|team): \{$/gm)].map(m => m[1]);
    expect(order).toEqual(['free', 'basic', 'pro', 'team']);
    expect(PLANS.map(p => p.id)).toEqual(order);
  });

  it('prices the four tiers as the Stripe catalogue does', () => {
    // $0 / $9 / $20 / $80, created in Stripe on 18 Sept 2026. Free has no
    // price object at all — it is the absence of a subscription.
    expect(PLANS.map(p => p.price)).toEqual(['$0', '$9', '$20', '$80']);
  });

  it.each(['free', 'basic', 'pro', 'team'])(
    'states %s storage, agents, keys, members and file size as plans.ts does',
    plan => {
      const { field } = limitsOf(plan);
      const card = PLANS.find(p => p.id === plan);
      const text = card.lines.join(' · ');

      expect(text).toContain(sizeLabel(field('storageBytes')));
      expect(text).toContain(sizeLabel(field('maxFileBytes')));
      // Singular on Free, which holds one of nearly everything.
      expect(text).toMatch(new RegExp(`\\b${field('agents')} agent identit`));
      expect(text).toContain(`${field('apiKeys')} API key`);
      expect(text).toContain(`${field('members')} member`);
      expect(text).toContain(`${field('workspaces')} workspace`);
    }
  );

  it('promises no cap on anything plans.ts leaves unlimited', () => {
    for (const plan of ['free', 'basic', 'pro', 'team']) {
      const { field } = limitsOf(plan);
      // If one of these ever gains a real number, this test fails and the
      // card has to start stating it — which is the point.
      expect(field('requestsPerPeriod')).toBe('UNLIMITED');
      expect(field('egressBytesPerPeriod')).toBe('UNLIMITED');
      expect(field('fileCount')).toBe('UNLIMITED');
    }
    mount();
    expect(screen.queryByText(/requests \/ month/i)).toBeNull();
    expect(screen.queryByText(/100,000/)).toBeNull();
  });

  it('renders one card per plan, with its price and its CTA', () => {
    mount();
    for (const p of PLANS) {
      const card = screen.getByText(p.kicker).closest('.mk__plan');
      expect(within(card).getByText(p.price)).toBeTruthy();
      expect(within(card).getByRole('link', { name: p.cta })).toBeTruthy();
      for (const line of p.lines) expect(within(card).getByText(line)).toBeTruthy();
    }
  });

  it('sells no priority support and quotes no overage rate', () => {
    // Both are real decisions rather than omissions: support is "display only"
    // in the entitlement table, and pricing is hard-capped with no metered
    // tier above a limit. Inventing either is how backlog/024 started.
    mount();
    expect(screen.queryByText(/priority support/i)).toBeNull();
    expect(screen.queryByText(/metered above plan limits/i)).toBeNull();
    expect(OVERAGES).toEqual([]);
  });

  it('does not headline a meter that does not exist', () => {
    mount();
    // "Pay for storage and requests" outlived the requests meter by a release.
    expect(screen.queryByText(/pay for storage and requests/i)).toBeNull();
    expect(screen.getByText(/pay for storage\. nothing else\./i)).toBeTruthy();
  });

  it('says the counts are account-wide, because they are', () => {
    mount();
    expect(
      screen.getByText(/counted across your whole account/i)
    ).toBeTruthy();
  });

  it('keeps the free-tier sentence in step with the free card', () => {
    // The landing band and the signup panel both interpolate this string, so
    // it is the one piece of pricing copy that can go stale somewhere else.
    const free = PLANS.find(p => p.id === 'free');
    const { field } = limitsOf('free');
    expect(FREE_SUMMARY).toContain(sizeLabel(field('storageBytes')));
    expect(free.lines[0]).toContain(sizeLabel(field('storageBytes')));
  });
});
