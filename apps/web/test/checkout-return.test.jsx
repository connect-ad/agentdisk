/**
 * Stripe Checkout's return: `?checkout=success` is the `purchase` event, and
 * the parameter is dropped afterwards so a reload does not count it twice.
 */

import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const trackEvent = vi.fn();
vi.mock('../src/lib/analytics.js', () => ({ trackEvent, trackPageView: vi.fn() }));

const { PageMeta } = await import('../src/App.jsx');

let seen;
function Where() {
  const { pathname, search } = useLocation();
  seen = `${pathname}${search}`;
  return null;
}

function at(url) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <PageMeta />
      <Where />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  trackEvent.mockClear();
});

describe('returning from Stripe Checkout', () => {
  it('a success is one purchase, and the parameter is dropped', () => {
    at('/w/acme/billing?checkout=success');
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('purchase');
    expect(seen).toBe('/w/acme/billing');
  });

  it('a cancellation is no purchase, and the parameter is dropped', () => {
    at('/w/acme/billing?checkout=cancelled&tab=plans');
    expect(trackEvent).not.toHaveBeenCalled();
    expect(seen).toBe('/w/acme/billing?tab=plans');
  });

  it('any other page sends nothing', () => {
    at('/w/acme/billing');
    expect(trackEvent).not.toHaveBeenCalled();
    expect(seen).toBe('/w/acme/billing');
  });
});
