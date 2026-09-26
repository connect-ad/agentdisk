/**
 * The consent notice and its two dialogs.
 *
 * What these tests actually protect is the honesty of the thing, not its
 * layout. Two properties matter:
 *
 *   1. **A decision is recorded, and absence of one is a "no".** A notice that
 *      collects an answer and drops it is `backlog/023` with a legal edge: the
 *      person believes they have switched something off. So every path through
 *      the bar is checked against what `lib/consent.js` can read back, and an
 *      unreadable, stale or partial record has to read as undecided.
 *   2. **It never claims a category is running when it is not.** The product
 *      collects no analytics and sets no cookies (`Set-Cookie` appears nowhere
 *      in apps/api), and `routes/Legal.jsx` §9 says so. The copy is pinned
 *      here so it cannot drift into the design's "essential cookies keep you
 *      signed in", which is the true sentence for a different product.
 *
 * Storage is exercised for real — jsdom gives a working localStorage — because
 * a mocked store would pass while the JSON shape underneath changed.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import CookieNotice from '../src/components-local/CookieNotice.jsx';
import {
  CONSENT_VERSION, analyticsAllowed, marketingAllowed, readConsent, saveConsent
} from '../src/lib/consent.js';

const KEY = 'agentdisk.cookie-consent';

function mount() {
  render(<MemoryRouter><CookieNotice /></MemoryRouter>);
}

const bar = () => screen.queryByRole('region', { name: /cookie consent/i });

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { cleanup(); window.localStorage.clear(); vi.restoreAllMocks(); });

describe('the bar', () => {
  it('asks when nothing has been decided, and offers all four actions', () => {
    mount();
    expect(bar()).not.toBeNull();
    for (const label of ['Support', 'Manage preferences', 'Reject non-essential', 'Accept all']) {
      expect(screen.getByRole('button', { name: label })).not.toBeNull();
    }
  });

  it('does not ask again once a decision is stored', () => {
    saveConsent({ analytics: false, marketing: false });
    mount();
    expect(bar()).toBeNull();
  });

  it('says what is true: browser storage, and nothing collected yet', () => {
    mount();
    const text = bar().textContent;
    expect(text).toMatch(/kept in this browser/i);
    expect(text).toMatch(/collect nothing today/i);
    // The design's sentence, which is not true of this product.
    expect(text).not.toMatch(/Essential cookies keep you signed in/i);
  });
});

describe('a recorded decision', () => {
  it('accepts both optional categories and dismisses', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Accept all' }));

    expect(bar()).toBeNull();
    expect(analyticsAllowed()).toBe(true);
    expect(marketingAllowed()).toBe(true);
  });

  it('rejects both and still records the refusal, rather than staying silent', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Reject non-essential' }));

    expect(bar()).toBeNull();
    expect(analyticsAllowed()).toBe(false);
    // A refusal that stores nothing is indistinguishable from never being
    // asked, which is what would make the bar come back every single load.
    expect(readConsent()).not.toBeNull();
  });

  it('carries a version and a timestamp, so it can be re-asked later', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Accept all' }));

    const stored = JSON.parse(window.localStorage.getItem(KEY));
    expect(stored.v).toBe(CONSENT_VERSION);
    expect(Number.isFinite(Date.parse(stored.at))).toBe(true);
  });
});

describe('preferences', () => {
  it('stores one category without the other', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Manage preferences' }));
    await user.click(screen.getByRole('switch', { name: 'Product analytics' }));
    await user.click(screen.getByRole('button', { name: 'Save choices' }));

    expect(bar()).toBeNull();
    expect(analyticsAllowed()).toBe(true);
    expect(marketingAllowed()).toBe(false);
  });

  it('gives essential no switch at all, because it is not a choice', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Manage preferences' }));

    expect(screen.queryByRole('switch', { name: 'Essential' })).toBeNull();
    expect(screen.getAllByRole('switch')).toHaveLength(2);
    expect(screen.getByText('ALWAYS ON')).not.toBeNull();
  });

  it('marks both optional categories as not in use, twice over', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Manage preferences' }));

    expect(screen.getAllByText('NOT IN USE')).toHaveLength(2);
    expect(screen.getByRole('dialog').textContent)
      .toMatch(/Neither optional category is running/i);
  });

  it('cancels without recording anything, so the question stays open', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Manage preferences' }));
    await user.click(screen.getByRole('switch', { name: 'Product analytics' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(readConsent()).toBeNull();
    expect(bar()).not.toBeNull();
  });
});

describe('support', () => {
  it('names the address and offers it as a mailto', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Support' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/connect@agentdisk\.io/);
    const link = screen.getByRole('link', { name: /Email connect@agentdisk\.io/ });
    expect(link.getAttribute('href')).toMatch(/^mailto:connect@agentdisk\.io/);
  });

  it('does not answer the consent question on the way past', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Support' }));
    await user.click(screen.getByRole('button', { name: 'Not now' }));

    expect(readConsent()).toBeNull();
    expect(bar()).not.toBeNull();
  });
});

describe('a record that cannot be honoured reads as no record', () => {
  it('re-asks after 12 months', () => {
    const thirteenMonths = Date.now() - 396 * 24 * 60 * 60 * 1000;
    window.localStorage.setItem(KEY, JSON.stringify({
      v: CONSENT_VERSION, at: new Date(thirteenMonths).toISOString(), analytics: true, marketing: true
    }));

    expect(analyticsAllowed()).toBe(false);
    mount();
    expect(bar()).not.toBeNull();
  });

  it('re-asks when the categories have changed under it', () => {
    window.localStorage.setItem(KEY, JSON.stringify({
      v: CONSENT_VERSION + 1, at: new Date().toISOString(), analytics: true
    }));
    expect(readConsent()).toBeNull();
    mount();
    expect(bar()).not.toBeNull();
  });

  it('treats a missing flag as off rather than guessing', () => {
    window.localStorage.setItem(KEY, JSON.stringify({
      v: CONSENT_VERSION, at: new Date().toISOString(), analytics: true
    }));
    expect(readConsent()).toEqual(expect.objectContaining({ analytics: true, marketing: false }));
  });

  it('survives storage that refuses to answer, and still asks', () => {
    // Safari in private mode throws rather than returning null. A consent bar
    // is not worth a blank page, and an unreadable store is undecided.
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readConsent()).toBeNull();
    mount();
    expect(bar()).not.toBeNull();
  });

  it('dismisses for this page even when the write is refused', async () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Accept all' }));

    // Nothing was stored, so the next load asks again -- but asking twice on
    // the same page, after an answer, is the product ignoring the person.
    expect(bar()).toBeNull();
  });

  it('re-asks rather than throwing on a store somebody hand-edited', () => {
    window.localStorage.setItem(KEY, 'not json');
    expect(readConsent()).toBeNull();
    mount();
    expect(bar()).not.toBeNull();
  });
});
