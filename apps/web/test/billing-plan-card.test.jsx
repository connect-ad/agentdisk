/**
 * The Billing hero.
 *
 * The reference draws this screen as two cards: an accent CURRENT PLAN card
 * and a neutral one beside it. It fills them with a monthly price, a
 * next-invoice estimate and a card's last four digits — and `GET /v1/billing`
 * returns none of those, because Stripe holds them and this product never
 * reads them back (14 PART 29.1). Borrowing the chrome is therefore one edit
 * away from borrowing the numbers too, which is exactly the class of thing
 * `backlog/023` exists about: a screen that looks authoritative about money
 * it invented.
 *
 * So what is asserted here is not "the card renders" but "the card renders
 * the fields the API actually returned, and invents nothing about this
 * account's money" — the property that has to survive the next person who
 * opens the reference beside this file.
 *
 * **The screen now carries prices**, since the plan picker landed: a picker
 * without them is useless. That narrows the rule rather than repealing it.
 * Every figure comes from `lib/pricing.js`, the one public copy of the
 * catalogue, and none of them is a claim about what *this* customer will be
 * charged. A next-invoice estimate or a card's last four still would be.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PLANS } from '../src/lib/pricing.js';

let workspaceState = {
  api: {},
  workspaceId: 'ws_test',
  workspaceSlug: 'acme',
  role: 'owner'
};
vi.mock('../src/lib/workspace.jsx', () => ({
  useWorkspace: () => workspaceState
}));

let billingState = { status: 'ready', data: null, error: null, reload: () => {} };
vi.mock('../src/lib/useResource.js', () => ({
  useResource: () => billingState
}));

const { BillingTab } = await import('../src/routes/SettingsTabs.jsx');

const BILLING = {
  plan: 'team',
  status: 'active',
  configured: true,
  subscribed: true,
  ownerEmail: 'rina@kesslerlabs.example',
  writesBlocked: false
};

/** The ids the server says have a synced Stripe price in this environment. */
const PURCHASABLE = ['basic', 'pro', 'team'];

function show(billing = BILLING, role = 'owner', purchasable = PURCHASABLE) {
  workspaceState = { ...workspaceState, role };
  billingState = {
    status: 'ready',
    data: { billing, purchasable },
    error: null,
    reload: () => {}
  };
  return render(<MemoryRouter><BillingTab /></MemoryRouter>).container;
}

afterEach(cleanup);

describe('Billing hero', () => {
  it('carries the plan and the status the API returned', () => {
    show();
    expect(screen.getByText('Current plan')).toBeTruthy();
    expect(screen.getByText('team')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('puts the billing email and the payment line in the second card', () => {
    show();
    expect(screen.getByText('Billing account')).toBeTruthy();
    expect(screen.getByText('rina@kesslerlabs.example')).toBeTruthy();
    expect(screen.getByText('Managed on Stripe')).toBeTruthy();
  });

  it('says there is no subscription rather than describing a card', () => {
    show({ ...BILLING, subscribed: false, configured: false });
    expect(screen.getByText('No active subscription')).toBeTruthy();
    // Unconfigured billing asks you to set it up, not to "manage" nothing.
    expect(screen.getByRole('button', { name: 'Set up billing' })).toBeTruthy();
  });

  it('invents no figure about THIS account, whatever the plan picker shows', () => {
    // The screen now carries prices, because a plan picker without them is
    // useless. The property that has to survive is narrower and unchanged:
    // every figure comes from `lib/pricing.js`, the one public copy of the
    // catalogue, and none is a claim about what this customer will be charged.
    // An invoice estimate, an overage line or a card's last four would all be
    // inventions — `GET /v1/billing` returns none of them.
    const container = show();

    const prices = [...container.textContent.matchAll(/[$£€]\s?[\d.,]+/g)].map(m => m[0]);
    // Exactly the four catalogue prices, nothing else.
    expect(prices).toEqual(['$0', '$9', '$20', '$80']);

    expect(container.textContent).not.toMatch(/next invoice|estimate|ending in|•••/i);
  });

  it('takes its prices from the pricing module, not from the API response', () => {
    // `GET /v1/billing` deliberately sends `purchasable` — ids only — and no
    // numbers. If the server ever starts restating a price, this is where the
    // two copies would begin to disagree.
    const container = show();
    for (const plan of PLANS) {
      expect(container.textContent).toContain(plan.price);
    }
  });

  it('gives a reader the reason instead of a button that would be refused', () => {
    show(BILLING, 'reader');
    expect(screen.queryByRole('button', { name: 'Manage billing' })).toBeNull();
    expect(screen.getByText(/Only the account owner can change billing/)).toBeTruthy();
  });
});

/**
 * The plan picker — the screen that finally reaches checkout.
 *
 * `POST /v1/billing/checkout-session` shipped with `backlog/001` task 6 and no
 * UI ever called it, so three paid plans were priced, synced to Stripe and
 * unbuyable from inside the product. These tests are about which button each
 * card offers, because the combinations are where one state ends up
 * unreachable: an expired owner looking at a plan that is not theirs, a reader
 * looking at anything, a plan whose price was never synced.
 */
describe('the plan picker', () => {
  /** Never subscribed, no live period — the state a new account is in. */
  const FRESH = {
    plan: 'free',
    status: 'active',
    configured: false,
    subscribed: false,
    ownerEmail: 'rina@kesslerlabs.example',
    writesBlocked: false,
    periodEndsAt: null,
    renewalOpen: true,
    graceEndsAt: null,
    purgeAfter: null
  };

  const buttons = () =>
    screen.getAllByRole('button').map(el => el.textContent.trim());

  it('offers Subscribe on every plan with a synced price', () => {
    show(FRESH);
    const labels = buttons();
    expect(labels.filter(label => label === 'Subscribe')).toHaveLength(3);
  });

  it('never offers to buy Free, which is the absence of a purchase', () => {
    const container = show(FRESH);
    // Free's card renders — people need to see what they are on — but it
    // carries no button, because leaving a paid plan means letting it lapse.
    expect(container.textContent).toContain('1 GB storage');
    expect(buttons().filter(label => label === 'Subscribe')).toHaveLength(3);
  });

  it('disables a plan whose price this environment has not synced', () => {
    // Migration 0012 seeds the catalogue with NULL price ids. Saying so beats
    // a button whose only possible outcome is a 500.
    show(FRESH, 'owner', ['basic', 'team']);
    const disabled = screen
      .getAllByRole('button')
      .filter(el => el.disabled)
      .map(el => el.textContent.trim());
    expect(disabled).toEqual(['Not available yet']);
  });

  it('gives a reader no buttons at all', () => {
    show(FRESH, 'reader');
    expect(screen.queryByRole('button', { name: 'Subscribe' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Renew' })).toBeNull();
  });

  it('marks the current plan with a word, not only a colour', () => {
    show({ ...FRESH, plan: 'pro' });
    expect(screen.getByText('Your plan')).toBeTruthy();
  });
});

describe('the renewal clock', () => {
  const LIVE = {
    plan: 'pro',
    status: 'active',
    configured: true,
    subscribed: false,
    ownerEmail: 'rina@kesslerlabs.example',
    writesBlocked: false,
    periodEndsAt: Date.UTC(2026, 9, 14),
    renewalOpen: false,
    graceEndsAt: Date.UTC(2026, 9, 21),
    purgeAfter: null
  };

  it('says when the plan ends and that nothing renews it', () => {
    // The single most important fact under manual renewal, and one the API
    // could not report at all before migration 0027.
    const container = show(LIVE);
    expect(container.textContent).toContain('Ends 14 October 2026');
    expect(container.textContent).toMatch(/does not renew automatically/i);
  });

  it('offers no Renew while the period is comfortably live', () => {
    // The server refuses this window, so a button here would be a 409 waiting
    // to happen.
    show(LIVE);
    expect(screen.queryByRole('button', { name: 'Renew' })).toBeNull();
  });

  it('offers Renew once the server says the window is open', () => {
    show({ ...LIVE, renewalOpen: true });
    expect(screen.getByRole('button', { name: 'Renew' })).toBeTruthy();
  });

  it('names the deletion deadline once expired, and says nothing is gone', () => {
    const container = show({
      ...LIVE,
      status: 'expired',
      writesBlocked: true,
      renewalOpen: true
    });
    expect(container.textContent).toContain('Ended 14 October 2026');
    expect(container.textContent).toMatch(/stays readable/i);
    expect(container.textContent).toContain('21 October 2026');
    expect(container.textContent).toMatch(/scheduled for deletion/i);
  });

  it('says nothing about a period for an account that never bought one', () => {
    // NULL is "never had a plan", not "expired". Inventing a date here would
    // be the same lie in the other direction.
    const container = show({ ...LIVE, plan: 'free', periodEndsAt: null, graceEndsAt: null });
    expect(container.textContent).not.toMatch(/Ends \d|Ended \d/);
  });
});
