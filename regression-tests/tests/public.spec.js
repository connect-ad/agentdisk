/**
 * The signed-out surface: landing, pricing, docs, terms, privacy.
 *
 * Assertions are on roles, accessible names and destinations — never on class
 * names, colours or layout. A re-theme is *supposed* to change how these look;
 * it is not supposed to change where a link goes or which calls-to-action
 * exist. Anything asserted here would be a real loss of function.
 */

import { test, expect } from '@playwright/test';

/** Every route a stranger can reach, with something on it only that page has. */
const PUBLIC_ROUTES = [
  // Copy changed by the site rebuild, decision 4 in
  // docs/superpowers/specs/2026-09-14-site-rebuild-design.md: adopt the
  // design's copy across the marketing pages. Not a weakened assertion — it
  // still pins one sentence that only this page has.
  { path: '/', name: 'landing', expect: /Storage your agents can actually reason about/i },
  // Same decision 4.
  { path: '/pricing', name: 'pricing', expect: /Pay for storage and requests/i },
  { path: '/docs', name: 'docs', expect: /docs/i },
  { path: '/terms', name: 'terms', expect: /terms/i },
  { path: '/privacy', name: 'privacy', expect: /privacy/i },
];

for (const route of PUBLIC_ROUTES) {
  test(`${route.name} renders its own content`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    const response = await page.goto(route.path);
    expect(response.status(), `${route.path} did not return 200`).toBe(200);

    // The SPA answers 200 for unknown paths too (not_found_handling =
    // single-page-application), so status alone proves nothing. Content does.
    await expect(page.locator('body')).toContainText(route.expect, { timeout: 20_000 });

    expect(errors, `uncaught page errors on ${route.path}:\n${errors.join('\n')}`).toEqual([]);
  });
}

test('the landing page keeps its primary calls to action', async ({ page }) => {
  await page.goto('/');

  // Signed-out visitors must always have a way in and a way to read more.
  // The design's primary CTA is "Start free" (decision 4). The assertion is
  // that a signed-out visitor always has a way in, whatever it is labelled.
  await expect(page.getByRole('link', { name: /start free|create a workspace/i }).first())
    .toBeVisible();
  await expect(page.getByRole('link', { name: /^sign in$/i }).first()).toBeVisible();
});

test('the marketing nav reaches every public destination', async ({ page }) => {
  await page.goto('/');

  // These seven are the complete set of internal destinations Marketing.jsx
  // links to. Losing one during a re-theme is a dead end, not a style change.
  for (const href of ['/pricing', '/docs', '/login', '/signup', '/terms', '/privacy']) {
    await expect(
      page.locator(`a[href="${href}"]`).first(),
      `no link to ${href} anywhere on the landing page`
    ).toHaveCount(1);
  }
});

test('pricing links onward to signup', async ({ page }) => {
  await page.goto('/pricing');
  const cta = page.getByRole('link', { name: /choose a plan|create a free workspace|get started/i }).first();
  await expect(cta).toBeVisible();
  await cta.click();
  await page.waitForURL(/\/(signup|login)/, { timeout: 20_000 });
});

test('the landing page loads its stylesheet and fonts', async ({ page }) => {
  const failed = [];
  // Cloudflare injects its own analytics beacon into every response, and this
  // site's script-src blocks it. That is real and pre-existing — Web Analytics
  // does not work on app-dev — but it is not something a re-theme causes or
  // fixes, so it must not sit in this suite's signal. Everything the theme
  // actually controls is first-party or Google Fonts.
  const THIRD_PARTY_BEACONS = /cloudflareinsights\.com/;
  const relevant = url => !THIRD_PARTY_BEACONS.test(url);

  page.on('requestfailed', r => {
    if (relevant(r.url())) failed.push(`${r.failure()?.errorText} ${r.url()}`);
  });
  page.on('response', r => {
    if (r.status() >= 400 && /\.(css|js|woff2?)(\?|$)/.test(r.url()) && relevant(r.url())) {
      failed.push(`${r.status()} ${r.url()}`);
    }
  });

  await page.goto('/', { waitUntil: 'networkidle' });

  // A CSP that blocks the font stylesheet fails silently in the browser — the
  // page renders in a fallback face and nothing else complains.
  expect(failed, `blocked or failed assets:\n${failed.join('\n')}`).toEqual([]);
});
