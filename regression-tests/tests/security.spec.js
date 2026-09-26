/**
 * The three invariants that must survive any change to how the site looks.
 *
 * These are properties of the *deployed* response, which is why they are here
 * and not in the unit suites: `_headers` is written by a Vite plugin at build
 * time and applied by Cloudflare's asset server, so a build that silently stops
 * emitting it still passes every unit test and still deploys green.
 */

import { test, expect, request as pwRequest } from '@playwright/test';

const API_BASE = process.env.API_BASE || 'https://api-dev.agentdisk.io';

/**
 * The five headers scripts/security-headers.js emits. Named individually rather
 * than counted, so a run that loses one and gains another still fails.
 */
const REQUIRED_HEADERS = {
  'content-security-policy': /default-src 'self'/,
  'strict-transport-security': /max-age=31536000/,
  'x-frame-options': /^DENY$/i,
  'x-content-type-options': /^nosniff$/i,
  'referrer-policy': /^strict-origin-when-cross-origin$/i,
};

test.describe('security headers', () => {
  test('all five are present on the document response', async ({ page }) => {
    const response = await page.goto('/');
    expect(response, 'no response for /').toBeTruthy();

    const headers = await response.allHeaders();
    const missing = Object.keys(REQUIRED_HEADERS).filter(h => !(h in headers));
    expect(missing, 'missing security headers: ' + missing.join(', ')).toEqual([]);

    for (const [name, pattern] of Object.entries(REQUIRED_HEADERS)) {
      expect(headers[name], name + ' has an unexpected value').toMatch(pattern);
    }
  });

  test('the CSP still allows the font and API origins the app needs', async ({ page }) => {
    const response = await page.goto('/');
    const csp = (await response.allHeaders())['content-security-policy'];

    // The re-theme pulls three families from Google Fonts. If a build ever
    // tightens style-src or font-src past them, every page loses its typography
    // with no other symptom.
    expect(csp, 'style-src must allow the Google Fonts stylesheet')
      .toContain('https://fonts.googleapis.com');
    expect(csp, 'font-src must allow the Google Fonts files')
      .toContain('https://fonts.gstatic.com');
    expect(csp, 'connect-src must allow the API').toContain(API_BASE);
    // A re-theme reaching for an inline script would have to loosen exactly
    // this directive, so pin it.
    expect(csp, 'script-src must not gain unsafe-inline')
      .not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp, 'script-src must not gain unsafe-eval')
      .not.toMatch(/script-src[^;]*unsafe-eval/);
  });
});

/**
 * The real route table, read from apps/api/src/index.ts. An earlier draft of
 * this list invented /v1/me and /v1/usage; neither exists, and both correctly
 * answer 404. A genuinely missing route may say it is missing. What may not
 * happen is an existing authenticated route answering anything but 401 to a
 * caller with no valid credential.
 *
 * workspaceId is present on the routes that need it because these handlers
 * validate parameters before verifying the credential. Without it the caller
 * gets 400 VALIDATION_ERROR rather than 401 - a real ordering quirk, covered by
 * its own test below, but not a credential oracle: a forged key and a real one
 * are treated identically either way.
 */
const WS = 'workspaceId=ws_0000000000000000';
const ROUTES = [
  '/v1/workspaces',
  '/v1/whoami?' + WS,
  '/v1/files?' + WS,
  '/v1/folders?' + WS,
  '/v1/agents?' + WS,
  '/v1/keys?' + WS,
  '/v1/members?' + WS,
  '/v1/webhooks?' + WS,
  '/v1/activity?' + WS,
  '/v1/billing?' + WS,
  '/v1/search?' + WS + '&q=x',
];

const FORGED = 'Bearer adk_live_definitely_not_a_real_key_000000';

test.describe('unauthenticated API requests', () => {
  for (const [label, headers] of [
    ['absent', {}],
    ['forged', { Authorization: FORGED }],
  ]) {
    test('every route answers 401 with a ' + label + ' credential', async () => {
      const ctx = await pwRequest.newContext({ baseURL: API_BASE });
      const results = [];
      for (const route of ROUTES) {
        const res = await ctx.get(route, { headers, failOnStatusCode: false });
        results.push({ route, status: res.status() });
      }
      await ctx.dispose();

      const wrong = results.filter(r => r.status !== 401);
      expect(
        wrong,
        'an authenticated route must answer 401, never 404 or 200:\n' +
        wrong.map(r => '  ' + r.route + ' -> ' + r.status).join('\n')
      ).toEqual([]);
    });
  }

  test('the failure body is identical across routes and credential kinds', async () => {
    // CLAUDE.md: unknown, revoked, expired, forged and absent credentials must
    // stay indistinguishable. A difference tells an attacker which of their
    // guesses named something real.
    const ctx = await pwRequest.newContext({ baseURL: API_BASE });
    const bodies = new Map();

    for (const route of ['/v1/files?' + WS, '/v1/agents?' + WS, '/v1/keys?' + WS]) {
      for (const [kind, headers] of [
        ['absent', {}],
        ['forged-api-key', { Authorization: FORGED }],
        ['empty-bearer', { Authorization: 'Bearer ' }],
        ['no-scheme', { Authorization: 'not-even-a-scheme' }],
        ['jwt-shaped', { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.x' }],
      ]) {
        const res = await ctx.get(route, { headers, failOnStatusCode: false });
        // Request IDs legitimately differ per call; nothing else may.
        const body = (await res.text())
          .replace(/"request_?[Ii]d"\s*:\s*"[^"]*"/g, '"requestId":"<x>"');
        bodies.set(route + ' / ' + kind, res.status() + ' ' + body);
      }
    }
    await ctx.dispose();

    const distinct = new Set(bodies.values());
    expect(
      [...distinct],
      'an auth failure that varies by route or credential kind is an oracle:\n' +
      [...bodies].map(e => '  ' + e[0] + ' -> ' + e[1].slice(0, 120)).join('\n')
    ).toHaveLength(1);
  });

  test('parameter validation does not run before authentication', async () => {
    // KNOWN PRE-EXISTING FAILURE, recorded rather than hidden.
    //
    // With a parseable bearer token but no workspaceId, these routes answer 400
    // VALIDATION_ERROR: the parameter check runs before the credential is
    // verified, so an unauthenticated caller reaches validation logic and learns
    // which parameters a route wants. It is not a credential oracle - a real key
    // and a forged one behave identically - which is why it is a hardening item
    // rather than a blocker. But it does contradict the rule in CLAUDE.md that
    // every authentication failure returns one identical body.
    //
    // It fails at baseline, so it can never block this migration. It is here so
    // the migration does not quietly inherit it as expected behaviour.
    const ctx = await pwRequest.newContext({ baseURL: API_BASE });
    const results = [];
    for (const route of ['/v1/files', '/v1/agents', '/v1/keys', '/v1/members']) {
      const res = await ctx.get(route, { headers: { Authorization: FORGED }, failOnStatusCode: false });
      results.push({ route, status: res.status() });
    }
    await ctx.dispose();

    const wrong = results.filter(r => r.status !== 401);
    expect(
      wrong,
      'authentication must be decided before parameter validation:\n' +
      wrong.map(r => '  ' + r.route + ' -> ' + r.status).join('\n')
    ).toEqual([]);
  });
});

test.describe('protected routes when signed out', () => {
  // This project runs with no storageState, so these are genuinely anonymous.
  for (const path of ['/app', '/dashboard', '/w/ws_000000000000/files', '/w/ws_000000000000']) {
    test(path + ' redirects to the login screen', async ({ page }) => {
      await page.goto(path);
      await page.waitForURL(/\/login/, { timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    });
  }
});
