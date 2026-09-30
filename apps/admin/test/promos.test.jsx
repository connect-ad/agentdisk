/**
 * The promo-code screen.
 *
 * One behaviour here is worth more than the rest and is most of this file:
 * **unlimited and single-use have to reach Stripe as genuinely different
 * requests.** `max_redemptions` absent means no limit; `1` means one use. An
 * empty numeric field standing for "no limit" is the NULL-versus-minus-one
 * ambiguity the plan catalogue already forbids, and it is worse here, because
 * the wrong reading gives away unlimited discounts on a live price.
 *
 * Everything else is about not inventing a value: a coupon that came back
 * unexpanded reads as unavailable, never as a zero discount, and a code with no
 * cap says so in words rather than leaving a blank that looks like nobody has
 * used it.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const created = vi.fn();
const deactivated = vi.fn();
let listed = [];

vi.mock('../src/api.js', () => ({
  adminApi: {
    listPromos: async () => ({ promos: listed }),
    createPromo: async input => {
      created(input);
      return { promo: {} };
    },
    deactivatePromo: async (id, reason) => {
      deactivated(id, reason);
      return { promo: {} };
    }
  }
}));

const { Promos } = await import('../src/screens/Promos.jsx');

function promo(overrides = {}) {
  return {
    id: 'promo_1',
    code: 'WELCOME50',
    active: true,
    percentOff: 50,
    amountOffCents: null,
    currency: null,
    duration: 'once',
    durationMonths: null,
    maxRedemptions: null,
    timesRedeemed: 3,
    expiresAt: null,
    createdAt: Date.UTC(2026, 8, 1),
    createdBy: 'admin@agentdisk.io',
    ...overrides
  };
}

async function show(rows = [promo()]) {
  listed = rows;
  render(<Promos role="admin" onToast={() => {}} />);
  await screen.findByRole('button', { name: 'New code' });
}

/** Fill the create form and submit it, returning what reached the API. */
async function createWith(steps) {
  const user = userEvent.setup();
  await show([]);
  await user.click(screen.getByRole('button', { name: 'New code' }));
  await user.type(screen.getByLabelText('Code'), 'SUMMER25');
  await steps(user);
  await user.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(created).toHaveBeenCalled());
  return created.mock.calls.at(-1)[0];
}

beforeEach(() => {
  created.mockClear();
  deactivated.mockClear();
});
afterEach(cleanup);

describe('one-time versus unlimited', () => {
  it('omits the limit entirely for an unlimited code', async () => {
    // Stripe reads a missing key as "no limit". A zero would be a limit of
    // zero, which is a code nobody can ever redeem.
    const payload = await createWith(async () => {});
    expect(payload).not.toHaveProperty('maxRedemptions');
  });

  it('sends 1 for a single-use code', async () => {
    const payload = await createWith(async user => {
      await user.click(screen.getByRole('radio', { name: /Limited/ }));
      const field = screen.getByLabelText('Total redemptions allowed');
      await user.clear(field);
      await user.type(field, '1');
    });
    expect(payload.maxRedemptions).toBe(1);
  });

  it('sends the count for a capped code', async () => {
    const payload = await createWith(async user => {
      await user.click(screen.getByRole('radio', { name: /Limited/ }));
      const field = screen.getByLabelText('Total redemptions allowed');
      await user.clear(field);
      await user.type(field, '250');
    });
    expect(payload.maxRedemptions).toBe(250);
  });

  it('writes both cases out in words, so neither is an empty box', async () => {
    const user = userEvent.setup();
    await show([]);
    await user.click(screen.getByRole('button', { name: 'New code' }));

    expect(screen.getByRole('radio', { name: /Unlimited/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Limited/ })).toBeTruthy();
  });
});

describe('what it sends', () => {
  it('uppercases the code, matching what the server stores', async () => {
    const user = userEvent.setup();
    await show([]);
    await user.click(screen.getByRole('button', { name: 'New code' }));
    await user.type(screen.getByLabelText('Code'), 'summer25');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(created).toHaveBeenCalled());

    expect(created.mock.calls.at(-1)[0].code).toBe('SUMMER25');
  });

  it('converts a fixed amount from dollars to cents', async () => {
    // Every money value in this product is integer cents. A float reaching the
    // API would be a price nobody can represent exactly.
    const payload = await createWith(async user => {
      await user.click(screen.getByRole('radio', { name: /Fixed amount off/ }));
      await user.type(screen.getByLabelText('Amount off in dollars'), '5.50');
    });
    expect(payload.amountOffCents).toBe(550);
    expect(payload.currency).toBe('usd');
    expect(payload).not.toHaveProperty('percentOff');
  });

  it('sends a month count only for a repeating discount', async () => {
    const once = await createWith(async () => {});
    expect(once).not.toHaveProperty('durationMonths');

    created.mockClear();
    cleanup();

    const repeating = await createWith(async user => {
      await user.selectOptions(screen.getByLabelText('How long it lasts'), 'repeating');
    });
    expect(repeating.duration).toBe('repeating');
    expect(repeating.durationMonths).toBe(3);
  });

  it('refuses to submit a code too short to be one', async () => {
    const user = userEvent.setup();
    await show([]);
    await user.click(screen.getByRole('button', { name: 'New code' }));
    await user.type(screen.getByLabelText('Code'), 'ab');

    expect(screen.getByRole('button', { name: 'Create' }).disabled).toBe(true);
  });
});

describe('what it renders', () => {
  it('says unlimited rather than leaving the cap blank', async () => {
    // A blank in this column reads as "nobody has used it".
    await show([promo({ maxRedemptions: null, timesRedeemed: 3 })]);
    expect(screen.getByText('3 · unlimited')).toBeTruthy();
  });

  it('shows used against the cap when there is one', async () => {
    await show([promo({ maxRedemptions: 100, timesRedeemed: 3 })]);
    expect(screen.getByText('3 / 100')).toBeTruthy();
  });

  it('reports an unexpanded coupon as unavailable, never as no discount', async () => {
    await show([promo({ percentOff: null, amountOffCents: null })]);
    expect(screen.getByText('unavailable')).toBeTruthy();
  });

  it('names the state in a word, not only a colour', async () => {
    await show([promo({ active: false })]);
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Switch off' })).toBeNull();
  });

  it('says a code came from Stripe when nobody here made it', async () => {
    await show([promo({ createdBy: null })]);
    expect(screen.getByText('Created in Stripe')).toBeTruthy();
  });

  it('distinguishes no expiry from an expiry date', async () => {
    await show([promo({ expiresAt: null })]);
    expect(screen.getByText('No expiry')).toBeTruthy();
  });
});

describe('switching a code off', () => {
  it('asks for a reason and passes it on', async () => {
    const user = userEvent.setup();
    await show();
    await user.click(screen.getByRole('button', { name: 'Switch off' }));

    // `requireReason` gates the confirm until something is typed.
    const reason = await screen.findByLabelText(/reason/i);
    await user.type(reason, 'Campaign ended.');

    // Two buttons read "Switch off" — the row's, and the dialog's submit. The
    // dialog's is the one inside a form.
    const confirm = screen
      .getAllByRole('button', { name: 'Switch off' })
      .find(button => button.type === 'submit');
    await user.click(confirm);

    await waitFor(() => expect(deactivated).toHaveBeenCalled());
    expect(deactivated.mock.calls.at(-1)[0]).toBe('promo_1');
    expect(deactivated.mock.calls.at(-1)[1]).toContain('Campaign ended.');
  });

  it('warns that it cannot be undone, because Stripe does not allow it', async () => {
    const user = userEvent.setup();
    await show();
    await user.click(screen.getByRole('button', { name: 'Switch off' }));

    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();
  });
});
