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
 * the fields the API actually returned, and nothing that looks like a
 * currency figure" — the property that has to survive the next person who
 * opens the reference beside this file.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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

function show(billing = BILLING, role = 'owner') {
  workspaceState = { ...workspaceState, role };
  billingState = { status: 'ready', data: { billing }, error: null, reload: () => {} };
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

  it('shows no figure that could be read as money', () => {
    const container = show();
    // A price, an invoice estimate or an overage line would all land here.
    expect(container.textContent).not.toMatch(/[$£€]\s?\d/);
  });

  it('gives a reader the reason instead of a button that would be refused', () => {
    show(BILLING, 'reader');
    expect(screen.queryByRole('button', { name: 'Manage billing' })).toBeNull();
    expect(screen.getByText(/Only the account owner can change billing/)).toBeTruthy();
  });
});
