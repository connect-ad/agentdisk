/**
 * Google Analytics 4, behind the consent gate.
 *
 * ── The gate ───────────────────────────────────────────────────────────────
 * Nothing here runs until `analyticsAllowed()` says yes. No decision is a no,
 * so a first visit loads nothing from Google until the person answers the
 * notice — and `CookieNotice` calls `applyAnalyticsConsent` the moment they
 * do, so an "Accept" starts collection on the page they are on rather than on
 * the next load, and a later "off" stops it on this one.
 *
 * ── Why there is no snippet in index.html ──────────────────────────────────
 * Google's install instructions are an inline <script>, and the CSP allows no
 * inline script (`scripts/security-headers.js`, `script-src`). So the
 * `dataLayer`/`gtag` shim lives here as module code and the loader is injected
 * as an external script from `www.googletagmanager.com`, which is the one host
 * the policy admits for it. `gtag` must push the `arguments` object itself,
 * never an array: gtag.js ignores array entries it did not expect.
 *
 * ── What Google is told, and what it is not ────────────────────────────────
 * The address bar in this product carries secrets and customer data: a claim
 * link's token is ownership of a workspace, a share link's token is read
 * access to a file, Firebase's email-link and reset flows put a one-time
 * `oobCode` in the query string, and `/w/{slug}/files/...` spells out a
 * customer's workspace and folder names. gtag.js reads `location.href` by
 * default, so every hit carries `page_location` built by `analyticsPath`
 * instead: the route *template*, no query string, no fragment. Page titles
 * come from `lib/seo.js`'s static table and never name a workspace or a file.
 *
 * Ads storage, ad personalisation and Google signals are all refused.
 *
 * ── What the GA console must also be told ───────────────────────────────────
 * Enhanced measurement runs inside gtag.js and no code here can switch it
 * off. Two of its features defeat the rules above and must be off on the
 * stream: *Page changes based on browser history events* (it would double
 * every page view this module sends), and *Outbound clicks* / *File
 * downloads* (a download clicks an anchor whose href is a presigned R2 URL —
 * a signed, working link to a customer's file).
 *
 * Every entry point is a no-op during the prerender, in tests, and on the
 * Vite dev server, so nothing here fires from a laptop — and in any build
 * but prod's. `VITE_ANALYTICS` is `on` only when CI builds for the `prod`
 * environment (frontend.yml), so app-dev's test traffic never reaches the
 * property and an unset variable means off, as `ENVIRONMENT_NAME` does for
 * indexing.
 *
 * ── Events ─────────────────────────────────────────────────────────────────
 * Beyond page views, `trackEvent` sends the funnel's few steps, under GA4's
 * recommended names so the console recognises them: `sign_up` and `login`
 * (with `method`), `begin_checkout` and `purchase` (with our plan id). No
 * parameter ever names a person, a workspace or a file.
 */

import { analyticsAllowed } from './consent.js';

export const GA_MEASUREMENT_ID = 'G-20LJDYJVHD';
export const GA_SCRIPT_ORIGIN = 'https://www.googletagmanager.com';

/** The loader has been injected; gtag.js stays on the page once it has. */
let loaded = false;
/** Collection is on for this page: consent given and not since withdrawn. */
let enabled = false;

function available() {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
    && !import.meta.env.DEV && import.meta.env.VITE_ANALYTICS === 'on';
}

/** The standard shim. Defined once, on window, where gtag.js looks for it. */
function gtag() {
  window.dataLayer.push(arguments);
}

/**
 * The path Google is given for a real pathname: the route with every
 * identifying segment replaced by its parameter name. Anything not listed
 * passes through, which is right for the fixed marketing, auth and error
 * routes and is the only case where a path reaches Google verbatim.
 */
export function analyticsPath(pathname = '/') {
  const parts = String(pathname).split('/').filter(Boolean);
  if (parts[0] === 'claim' && parts.length > 1) return '/claim/:token';
  if (parts[0] === 's' && parts.length > 1) return '/s/:token';
  if (parts[0] === 'w' && parts.length > 1) {
    const section = parts[2];
    if (!section) return '/w/:workspace';
    // Folder paths under files/ are customer data; agent ids are opaque but
    // unbounded, and one row per agent is noise, not a page.
    if (section === 'files') return '/w/:workspace/files';
    if (section === 'agents' && parts.length > 3) return '/w/:workspace/agents/:agent';
    return `/w/:workspace/${section}`;
  }
  return `/${parts.join('/')}`;
}

function pageLocation(pathname) {
  return `${window.location.origin}${analyticsPath(pathname)}`;
}

function start(pathname) {
  if (enabled) return;
  enabled = true;
  window[`ga-disable-${GA_MEASUREMENT_ID}`] = false;
  if (loaded) {
    // Withdrawn and given again on the same page: gtag.js is already here.
    window.gtag('consent', 'update', { analytics_storage: 'granted' });
    return;
  }
  loaded = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || gtag;

  window.gtag('consent', 'default', {
    analytics_storage: 'granted',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });
  window.gtag('js', new Date());
  window.gtag('config', GA_MEASUREMENT_ID, {
    // Page views are sent by `trackPageView`, with a scrubbed location. The
    // automatic one would read location.href.
    send_page_view: false,
    page_location: pageLocation(pathname),
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });

  const script = document.createElement('script');
  script.async = true;
  script.src = `${GA_SCRIPT_ORIGIN}/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(script);
}

/**
 * One page view for the route now showing. Called from `App.jsx` after the
 * page's title is set, so the title Google records is this page's.
 */
export function trackPageView(pathname) {
  if (!available() || !analyticsAllowed()) return;
  start(pathname);
  const location = pageLocation(pathname);
  // `set` as well as the event, so anything gtag.js sends on its own between
  // page views carries the scrubbed address too.
  window.gtag('set', { page_location: location });
  window.gtag('event', 'page_view', { page_location: location, page_title: document.title });
}

/**
 * One named event, on a page where collection is already on. `trackPageView`
 * runs on every route first, so with consent this is always the case; without
 * it, or after a no, this sends nothing.
 */
export function trackEvent(name, params = {}) {
  if (!available() || !enabled) return;
  window.gtag('event', name, params);
}

/** Removes the `_ga` cookies gtag.js set, from every domain it could have used. */
function clearGaCookies() {
  const names = document.cookie
    .split(';')
    .map(c => c.split('=')[0].trim())
    .filter(n => n === '_ga' || n.startsWith('_ga_'));
  const labels = window.location.hostname.split('.');
  // cookie_domain 'auto' picks the widest domain that accepts a cookie, so try
  // each suffix: app-dev.agentdisk.io, agentdisk.io, and host-only.
  const domains = [''];
  for (let i = 0; i < labels.length - 1; i += 1) domains.push(`; domain=.${labels.slice(i).join('.')}`);
  for (const name of names) {
    for (const domain of domains) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`;
    }
  }
}

/**
 * Called with a fresh decision from the consent notice. A yes starts
 * collection on this page; a no stops it and removes the cookies, so turning
 * analytics off is not merely "stop sending from the next load".
 */
export function applyAnalyticsConsent({ analytics }) {
  if (!available()) return;
  if (analytics) {
    trackPageView(window.location.pathname);
    return;
  }
  if (!enabled) return;
  enabled = false;
  window.gtag('consent', 'update', { analytics_storage: 'denied' });
  window[`ga-disable-${GA_MEASUREMENT_ID}`] = true;
  clearGaCookies();
}

/** Test seam: forget module state between cases. */
export function resetAnalyticsForTests() {
  loaded = false;
  enabled = false;
}
