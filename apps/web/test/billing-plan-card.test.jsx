/**
 * The Billing screen.
 *
 * The reference draws this as two cards: an accent CURRENT PLAN card and a
 * neutral one beside it. It fills them with a monthly price, a next-invoice
 * estimate and a card's last four digits — and `GET /v1/billing` returns
 * neither of the last two, because Stripe holds them and this product never
 * reads them back (14 PART 29.1). Borrowing the chrome is therefore one edit
 * away from borrowing the numbers too, which is exactly the class of thing
 * `backlog/023` exists about: a screen that looks authoritative about money it
 * invented.
 *
 * So what is asserted here is not "the card renders" but "the card renders the
 * fields the API actually returned, and invents nothing about this account's
 * money" — the property that has to survive the next person who opens the
 * reference beside this file.
 *
 * **Prices now come from the server**, since auto-renewal and yearly billing
 * landed. That narrows the rule rather than repealing it: the two amounts are
 * what Stripe will actually charge, so quoting them is the opposite of
 * inventing. A next-invoice estimate or a card's last four still would be.
 *
 * ── The verb is the thing most worth testing here ──────────────────────────
 * "Renews 14 October" and "Ends 14 October" differ by one field —
 * `cancelAtPeriodEnd` — and getting it backwards on a cancelled subscription
 * reads to the customer as the cancellation having failed. Several tests below
 * exist only to pin that.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  writesBlocked: false,
  interval: 'month',
  cancelAtPeriodEnd: false,
  periodEndsAt: Date.UTC(2026, 9, 14),
  renewalAmountCents: 8000,
  pastDueSince: null,
  graceEndsAt: null,
  purgeAfter: null
};

/**
 * What the server says is buyable here, and at what.
 *
 * Objects rather than ids since migration 0029: a plan is purchasable
 * *monthly*, *yearly* or both, and a yearly button for a plan with no yearly
 * price produces a checkout that can only fail.
 */
const PURCHASABLE = [
  { id: 'basic', monthlyCents: 900, yearlyCents: 9100, savePercent: 15 },
  { id: 'pro', monthlyCents: 2000, yearlyCents: 20400, savePercent: 15 },
  { id: 'team', monthlyCents: 8000, yearlyCents: 81600, savePercent: 15 }
];

function show(billing = BILLING, role = 'owner', purchasable = PURCHASABLE, api = {}) {
  workspaceState = { ...workspaceState, role, api };
  billingState = {
    status: 'ready',
    data: { billing, purchasable },
    error: null,
    reload: () => {}
  };
  return render(<MemoryRouter><BillingTab /></MemoryRouter>).container;
}

const buttons = () => screen.getAllByRole('button').map(el => el.textContent.trim());

afterEach(cleanup);

describe('Billing hero', () => {
  it('carries the plan and the status the API returned', () => {
    show();
    expect(screen.getByText('Current plan')).toBeTruthy();
    expect(screen.getByText('team')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('puts the billing email, cadence and payment line in the second card', () => {
    show();
    expect(screen.getByText('Billing account')).toBeTruthy();
    expect(screen.getByText('rina@kesslerlabs.example')).toBeTruthy();
    // The word appears on the interval toggle too, so this asks for the one
    // inside the Billing account card specifically.
    expect(screen.getByText('Billing period').closest('div').textContent).toContain('Monthly');
    expect(screen.getByText('Managed on Stripe')).toBeTruthy();
  });

  it('says there is no subscription rather than describing a card', () => {
    show({ ...BILLING, subscribed: false, configured: false, interval: null });
    expect(screen.getAllByText('No active subscription').length).toBeGreaterThan(0);
    // Unconfigured billing asks you to set it up, not to "manage" nothing.
    expect(screen.getByRole('button', { name: 'Set up billing' })).toBeTruthy();
  });

  it('invents no figure about THIS account beyond what Stripe will charge', () => {
    // The narrowed rule. Prices are now server data and quoting them is the
    // opposite of inventing; an invoice estimate, an overage line or a card's
    // last four would all still be inventions, because `GET /v1/billing`
    // returns none of them.
    const container = show();
    expect(container.textContent).not.toMatch(/next invoice|estimate|ending in|•••/i);
  });

  it('shows only the amounts the server sent, not a second hardcoded copy', () => {
    // If a figure appears here that the API never sent, a second copy of the
    // pricing table has crept back in and the two will drift.
    const container = show();
    const prices = [...container.textContent.matchAll(/\$[\d,]+(?:\.\d{2})?/g)].map(m => m[0]);
    for (const price of prices) {
      expect(['$0', '$9.00', '$20.00', '$80.00']).toContain(price);
    }
  });

  it('gives a reader the reason instead of a button that would be refused', () => {
    show(BILLING, 'reader');
    expect(screen.queryByRole('button', { name: /Payment method/ })).toBeNull();
    expect(screen.getByText(/Only the account owner can change billing/)).toBeTruthy();
  });
});

/**
 * The plan picker.
 *
 * These tests are about which button each card offers, because the
 * combinations are where one state ends up unreachable: an owner mid-dunning
 * looking at a plan that is not theirs, a reader looking at anything, a plan
 * whose yearly price was never minted.
 */
describe('the plan picker', () => {
  /** Never subscribed — the state a new account is in. */
  const FRESH = {
    plan: 'free',
    status: 'active',
    configured: false,
    subscribed: false,
    ownerEmail: 'rina@kesslerlabs.example',
    writesBlocked: false,
    interval: null,
    cancelAtPeriodEnd: false,
    periodEndsAt: null,
    renewalAmountCents: null,
    pastDueSince: null,
    graceEndsAt: null,
    purgeAfter: null
  };

  it('offers Subscribe on every plan with a synced price', () => {
    show(FRESH);
    expect(buttons().filter(label => label === 'Subscribe')).toHaveLength(3);
  });

  it('never offers to buy Free, which is the absence of a purchase', () => {
    const container = show(FRESH);
    // Free's card renders — people need to see what they are on — but it
    // carries no button, because leaving a paid plan means cancelling it.
    expect(container.textContent).toContain('1 GB storage');
    expect(buttons().filter(label => label === 'Subscribe')).toHaveLength(3);
  });

  it('disables a plan whose price this environment has not synced', () => {
    // Migration 0012 seeds the catalogue with NULL price ids. Saying so beats
    // a button whose only possible outcome is a 500.
    show(FRESH, 'owner', PURCHASABLE.filter(row => row.id !== 'pro'));
    const disabled = screen
      .getAllByRole('button')
      .filter(el => el.disabled)
      .map(el => el.textContent.trim());
    expect(disabled).toEqual(['Not available']);
  });

  it('gives a reader no buttons at all', () => {
    show(FRESH, 'reader');
    expect(screen.queryByRole('button', { name: 'Subscribe' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel subscription/ })).toBeNull();
  });

  it('marks the current plan with a word, not only a colour', () => {
    show({ ...FRESH, plan: 'pro' });
    expect(screen.getByText('Your plan')).toBeTruthy();
  });

  it('offers a switch, not a second Subscribe, when a subscription is live', () => {
    // Buying again would be a second subscription on the same card — the kind
    // of duplicate nobody notices until the second invoice, and the server
    // refuses it outright.
    show(BILLING);
    expect(buttons()).not.toContain('Subscribe');
    expect(buttons().filter(label => label === 'Switch to this')).toHaveLength(2);
  });
});

/**
 * The interval toggle.
 *
 * Yearly is sold at a discount, so the saving has to be visible on the control
 * itself — it is the reason to press it — and the percentage has to come from
 * the real amounts rather than a constant, or a price edit leaves the badge
 * advertising a discount nobody is giving.
 */
describe('monthly and yearly', () => {
  it('shows the saving on the control that switches to it', () => {
    show();
    expect(screen.getByRole('button', { name: /Yearly · save 15%/ })).toBeTruthy();
  });

  it('swaps every card to the yearly amount when pressed', () => {
    const container = show();
    expect(container.textContent).toContain('$20.00');

    fireEvent.click(screen.getByRole('button', { name: /Yearly/ }));

    expect(container.textContent).toContain('$204.00');
    expect(container.textContent).toContain('/ year');
  });

  it('opens on the cadence the account already bills at', () => {
    // Somebody on a yearly plan must not open this screen to a grid of monthly
    // prices that disagree with their own invoice.
    const container = show({ ...BILLING, interval: 'year', renewalAmountCents: 81600 });
    expect(container.textContent).toContain('$816.00');
    expect(screen.getByRole('button', { name: /Yearly/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('disables a plan at a cadence it is not sold at', () => {
    show(BILLING, 'owner', [
      ...PURCHASABLE.filter(row => row.id !== 'pro'),
      { id: 'pro', monthlyCents: 2000, yearlyCents: null, savePercent: null }
    ]);
    fireEvent.click(screen.getByRole('button', { name: /Yearly/ }));

    const disabled = screen
      .getAllByRole('button')
      .filter(el => el.disabled)
      .map(el => el.textContent.trim());
    expect(disabled).toEqual(['Not available']);
  });
});

/**
 * The renewal clock — and the verb.
 *
 * "Renews 14 October" and "Ends 14 October" differ by one boolean. Saying
 * "renews" to somebody who cancelled last week is the single most alarming
 * message this screen can produce.
 */
describe('the renewal clock', () => {
  it('names the next charge, the date and the cadence', () => {
    const container = show();
    expect(container.textContent).toContain('Renews 14 October 2026 for $80.00');
    expect(container.textContent).toMatch(/renews automatically every month/i);
  });

  it('says Ends, not Renews, once it has been cancelled', () => {
    const container = show({ ...BILLING, cancelAtPeriodEnd: true, renewalAmountCents: null });
    expect(container.textContent).toContain('Ends 14 October 2026');
    expect(container.textContent).not.toMatch(/Renews 14 October/);
    expect(container.textContent).toMatch(/will not renew/i);
  });

  it('offers Resume on a cancelled subscription, and Cancel on a live one', () => {
    show({ ...BILLING, cancelAtPeriodEnd: true });
    expect(screen.getByRole('button', { name: 'Resume subscription' })).toBeTruthy();

    cleanup();
    show(BILLING);
    expect(screen.getByRole('button', { name: 'Cancel subscription' })).toBeTruthy();
  });

  it('names the likely cause and the deadline while a card is being retried', () => {
    const container = show({
      ...BILLING,
      status: 'past_due',
      writesBlocked: true,
      pastDueSince: Date.UTC(2026, 9, 14),
      graceEndsAt: Date.UTC(2026, 9, 21)
    });
    expect(container.textContent).toMatch(/could not take payment/i);
    expect(container.textContent).toMatch(/expired or replaced card/i);
    expect(container.textContent).toContain('21 October 2026');
    expect(container.textContent).toMatch(/stays readable/i);
  });

  it('says what is scheduled once expired, and that nothing is gone yet', () => {
    const container = show({
      ...BILLING,
      status: 'expired',
      writesBlocked: true,
      pastDueSince: Date.UTC(2026, 9, 14)
    });
    expect(container.textContent).toMatch(/scheduled for deletion/i);
    expect(container.textContent).toMatch(/nothing has been removed yet/i);
  });

  it('says nothing about a period for an account that never bought one', () => {
    // NULL is "never had a plan", not "expired". Inventing a date here would
    // be the same lie in the other direction.
    const container = show({
      ...BILLING,
      plan: 'free',
      subscribed: false,
      interval: null,
      periodEndsAt: null,
      renewalAmountCents: null
    });
    expect(container.textContent).not.toMatch(/Renews \d|Ends \d/);
  });
});

/**
 * Cancelling — the one flow that has to be reversible and has to say so.
 */
describe('cancelling', () => {
  it('confirms first, and the dialog says what is actually lost', () => {
    show(BILLING);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));

    expect(screen.getByText('Cancel this subscription?')).toBeTruthy();
    expect(screen.getByRole('dialog').textContent).toMatch(/14 October 2026/);
    expect(screen.getByRole('dialog').textContent).toMatch(/nothing is deleted/i);
  });

  it('does not dress a reversible act in the danger treatment', async () => {
    // `ConfirmModal` defaults `destructive` to true. Red is right for deleting
    // a workspace and wrong here: nothing is deleted, and the decision can be
    // taken back until the date arrives. Teaching people to click through red
    // dialogs is how the ones that matter stop working.
    show(BILLING);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    expect(screen.getByRole('dialog').textContent).not.toMatch(/cannot be undone/i);
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeTruthy();
  });

  it('calls the cancel endpoint, not the Stripe portal', async () => {
    // The whole reason this endpoint exists. Sending somebody to a hosted
    // portal to stop paying is the friction consumer-protection rules were
    // written to remove.
    const cancelSubscription = vi.fn().mockResolvedValue({
      cancelAtPeriodEnd: true,
      periodEndsAt: Date.UTC(2026, 9, 14)
    });
    const createPortalSession = vi.fn();

    show(BILLING, 'owner', PURCHASABLE, { cancelSubscription, createPortalSession });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }));

    await screen.findByText(/Subscription cancelled/);
    expect(cancelSubscription).toHaveBeenCalledWith('ws_test');
    expect(createPortalSession).not.toHaveBeenCalled();
  });
});
