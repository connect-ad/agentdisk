/**
 * Google Analytics, behind consent, with a scrubbed address.
 *
 * Two properties are worth a test, both of them the kind a browser shows
 * nobody: nothing from Google loads without a recorded yes, and the address
 * Google is given never carries a token, a workspace name or a file path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GA_MEASUREMENT_ID, analyticsPath, applyAnalyticsConsent, resetAnalyticsForTests, trackEvent, trackPageView
} from '../src/lib/analytics.js';
import { saveConsent } from '../src/lib/consent.js';

const gaScripts = () => document.head.querySelectorAll('script[src*="googletagmanager.com/gtag/js"]');
/** The dataLayer entries as plain arrays, so they can be matched. */
const calls = () => (window.dataLayer || []).map(args => Array.from(args));
const pageViews = () => calls().filter(c => c[0] === 'event' && c[1] === 'page_view');
const events = name => calls().filter(c => c[0] === 'event' && c[1] === name);

beforeEach(() => {
  // gtag is a no-op on the dev server and in dev's build; this is prod's.
  vi.stubEnv('DEV', false);
  vi.stubEnv('VITE_ANALYTICS', 'on');
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetAnalyticsForTests();
  gaScripts().forEach(s => s.remove());
  delete window.dataLayer;
  delete window.gtag;
  delete window[`ga-disable-${GA_MEASUREMENT_ID}`];
  window.localStorage.clear();
});

describe('analyticsPath', () => {
  it.each([
    ['/claim/abc123secret', '/claim/:token'],
    ['/s/sharetoken', '/s/:token'],
    ['/w/acme', '/w/:workspace'],
    ['/w/acme/files/clients/secret-plan', '/w/:workspace/files'],
    ['/w/acme/agents/ag_123', '/w/:workspace/agents/:agent'],
    ['/w/acme/billing', '/w/:workspace/billing'],
    ['/pricing', '/pricing'],
    ['/', '/'],
  ])('%s -> %s', (input, expected) => {
    expect(analyticsPath(input)).toBe(expected);
  });
});

describe('without consent', () => {
  it('loads nothing when no decision exists', () => {
    trackPageView('/pricing');
    expect(gaScripts()).toHaveLength(0);
    expect(window.dataLayer).toBeUndefined();
  });

  it('loads nothing after a no', () => {
    saveConsent({ analytics: false });
    trackPageView('/pricing');
    expect(gaScripts()).toHaveLength(0);
  });

  it("loads nothing in a build that is not prod's, even with a yes", () => {
    vi.stubEnv('VITE_ANALYTICS', 'off');
    saveConsent({ analytics: true });
    trackPageView('/pricing');
    expect(gaScripts()).toHaveLength(0);
  });

  it('sends no event', () => {
    trackPageView('/signup');
    trackEvent('sign_up', { method: 'password' });
    expect(window.dataLayer).toBeUndefined();
  });

  it('loads nothing on the dev server, even with a yes', () => {
    vi.stubEnv('DEV', true);
    saveConsent({ analytics: true });
    trackPageView('/pricing');
    expect(gaScripts()).toHaveLength(0);
  });
});

describe('with consent', () => {
  it('injects gtag.js once and sends one page view per route', () => {
    saveConsent({ analytics: true });
    trackPageView('/pricing');
    trackPageView('/docs');
    expect(gaScripts()).toHaveLength(1);
    expect(pageViews()).toHaveLength(2);
  });

  it('refuses ads storage and sends no automatic page view', () => {
    saveConsent({ analytics: true });
    trackPageView('/');
    const consent = calls().find(c => c[0] === 'consent' && c[1] === 'default');
    expect(consent[2]).toEqual(expect.objectContaining({
      ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied'
    }));
    const config = calls().find(c => c[0] === 'config');
    expect(config[1]).toBe(GA_MEASUREMENT_ID);
    expect(config[2]).toEqual(expect.objectContaining({ send_page_view: false, allow_google_signals: false }));
  });

  it('never sends a claim token, and never sends the query string', () => {
    saveConsent({ analytics: true });
    window.history.pushState({}, '', '/claim/tok_secret?oobCode=abc#x');
    trackPageView('/claim/tok_secret');
    const sent = JSON.stringify(calls());
    expect(sent).not.toContain('tok_secret');
    expect(sent).not.toContain('oobCode');
    expect(pageViews()[0][2].page_location).toBe(`${window.location.origin}/claim/:token`);
    window.history.pushState({}, '', '/');
  });
});

describe('events', () => {
  it('sends a named event once collection is on', () => {
    saveConsent({ analytics: true });
    trackPageView('/signup');
    trackEvent('sign_up', { method: 'google' });
    expect(events('sign_up')).toEqual([['event', 'sign_up', { method: 'google' }]]);
  });

  it('sends nothing after a no', () => {
    applyAnalyticsConsent(saveConsent({ analytics: true }));
    applyAnalyticsConsent(saveConsent({ analytics: false }));
    trackEvent('login', { method: 'password' });
    expect(events('login')).toHaveLength(0);
  });
});

describe('a decision made on the page', () => {
  it('a yes starts collection immediately', () => {
    applyAnalyticsConsent(saveConsent({ analytics: true }));
    expect(gaScripts()).toHaveLength(1);
    expect(pageViews()).toHaveLength(1);
  });

  it('a no after a yes disables gtag and removes the _ga cookies', () => {
    applyAnalyticsConsent(saveConsent({ analytics: true }));
    document.cookie = '_ga=GA1.1.123; path=/';
    document.cookie = '_ga_20LJDYJVHD=GS1.1.456; path=/';

    applyAnalyticsConsent(saveConsent({ analytics: false }));
    expect(window[`ga-disable-${GA_MEASUREMENT_ID}`]).toBe(true);
    expect(document.cookie).not.toMatch(/_ga/);
    const update = calls().find(c => c[0] === 'consent' && c[1] === 'update');
    expect(update[2]).toEqual({ analytics_storage: 'denied' });

    // And no page views after it.
    const before = pageViews().length;
    trackPageView('/docs');
    expect(pageViews()).toHaveLength(before);
  });

  it('a yes again on the same page does not inject a second loader', () => {
    applyAnalyticsConsent(saveConsent({ analytics: true }));
    applyAnalyticsConsent(saveConsent({ analytics: false }));
    applyAnalyticsConsent(saveConsent({ analytics: true }));
    expect(gaScripts()).toHaveLength(1);
    expect(window[`ga-disable-${GA_MEASUREMENT_ID}`]).toBe(false);
  });
});
