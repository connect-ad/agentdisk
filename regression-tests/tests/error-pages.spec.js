/**
 * The error surface.
 *
 * `wrangler.toml` sets `not_found_handling = "single-page-application"`, so the
 * asset server answers 200 for every unknown path and React owns the not-found
 * screen. That means an HTTP status can never tell you whether these work —
 * only the rendered content can, which is exactly why they are easy to break
 * in a re-theme and hard to notice.
 */

import { test, expect } from '@playwright/test';

/**
 * The design specifies ten codes and the site rebuild added the six that had
 * no route (decision 6 in the phase 1 spec). Each asserts on the code chip and
 * the title, which are the two things only that page has.
 */
const ERROR_ROUTES = [
  { path: '/301', name: '301', expect: /this page has moved/i },
  { path: '/304', name: '304', expect: /already up to date/i },
  { path: '/400', name: '400', expect: /looks malformed/i },
  { path: '/401', name: '401', expect: /sign in to continue/i },
  { path: '/410', name: '410', expect: /was retired/i },
  { path: '/429', name: '429', expect: /too many requests/i },
  { path: '/403', name: '403', expect: /don't have access|403/i },
  { path: '/500', name: '500', expect: /went wrong on our end/i },
  { path: '/maintenance', name: 'maintenance', expect: /maintenance/i },
  { path: '/this-path-does-not-exist-xyz', name: '404 (unknown path)', expect: /couldn't find that page|404/i },
  { path: '/w/not-a-real-workspace-xyz/nowhere', name: '404 (unknown workspace path)', expect: /couldn't find|404|sign in/i },
];

for (const route of ERROR_ROUTES) {
  test(`${route.name} renders an error, not a blank page`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(route.path);
    await expect(page.locator('body')).toContainText(route.expect, { timeout: 20_000 });

    // A blank body is the failure mode that matters: the route resolved, React
    // mounted, and the screen rendered nothing.
    const text = (await page.locator('body').innerText()).trim();
    expect(text.length, `${route.path} rendered an essentially empty body`).toBeGreaterThan(20);

    expect(errors, `uncaught errors on ${route.path}:\n${errors.join('\n')}`).toEqual([]);
  });
}

test('the 500 screen keeps a working retry control', async ({ page }) => {
  await page.goto('/500');
  const retry = page.getByRole('button', { name: /try again|retry|reload/i }).first();
  await expect(retry).toBeVisible();
});

test('every error screen offers a way onward', async ({ page }) => {
  // A link home or a retry control both count. /500 deliberately offers only
  // Retry — reloading is the useful action for a server fault, and demanding a
  // link there would be asserting a design opinion rather than a behaviour.
  for (const path of ['/403', '/500', '/this-path-does-not-exist-xyz']) {
    await page.goto(path);
    const onward = page
      .locator('a[href="/"], a[href="/app"], a[href="/login"]')
      .or(page.getByRole('button', { name: /retry|try again|reload|back/i }))
      .first();
    await expect(onward, `${path} is a dead end — no link home and no retry`)
      .toBeVisible({ timeout: 20_000 });
  }
});

test('every error page shows its code and a family', async ({ page }) => {
  // The code chip and the REDIRECT/CLIENT/SERVER family are the design's way of
  // saying which kind of problem this is. Ten routes, one layout.
  const codes = [
    ['/301', '301', 'REDIRECT'], ['/304', '304', 'REDIRECT'],
    ['/400', '400', 'CLIENT'], ['/401', '401', 'CLIENT'],
    ['/403', '403', 'CLIENT'], ['/410', '410', 'CLIENT'],
    ['/429', '429', 'CLIENT'], ['/500', '500', 'SERVER'],
    ['/maintenance', '503', 'SERVER'],
  ];
  for (const [path, code, family] of codes) {
    await page.goto(path);
    const body = page.locator('body');
    await expect(body, path + ' did not show its code').toContainText(code, { timeout: 20_000 });
    await expect(body, path + ' did not show its family').toContainText(family);
  }
});

test('the 404 names the address that actually failed', async ({ page }) => {
  // The design fills this row with an invented URL. Showing the real one is
  // the point of the fact box — see the ErrorPages.jsx header.
  await page.goto('/some/path/that/is/not/real');
  await expect(page.locator('body')).toContainText('/some/path/that/is/not/real', { timeout: 20_000 });
});

test('no error page renders a link to nowhere', async ({ page }) => {
  // Related links are dropped when they have no destination, so every one that
  // renders must point at a real in-app route.
  for (const path of ['/301', '/400', '/401', '/403', '/410', '/429', '/500']) {
    await page.goto(path);
    await page.waitForTimeout(400);
    const hrefs = await page.locator('.err__link').evaluateAll(
      els => els.map(e => e.getAttribute('href'))
    );
    for (const href of hrefs) {
      expect(href, path + ' has a related link with no destination').toBeTruthy();
      expect(href, path + ' links to "#"').not.toBe('#');
    }
  }
});
