/**
 * The sign-in surface.
 *
 * The re-theme redraws all four of these screens, and they are the one place
 * where a purely visual mistake locks every user out. Each test asserts that
 * the *form* is still there and still wired — the fields, the submit control,
 * the provider buttons, and the links between screens.
 *
 * Nothing here submits real credentials; `scripts/login.mjs` is the only thing
 * that authenticates, and it does so through this same UI.
 */

import { test, expect } from '@playwright/test';

/**
 * `Input` renders the required marker as a span *inside* the <label>, so the
 * label's text is "Email*", not "Email". Matching loosely on the bare word
 * would also catch "New password" and "Confirm password" on the reset screen,
 * so anchor it and allow the optional asterisk.
 */
const byLabel = (page, field) => page.getByLabel(new RegExp('^' + field + '[*]?$'));

const SCREENS = [
  {
    path: '/login',
    name: 'login',
    heading: /log in|sign in/i,
    submit: /^sign in$/i,
    fields: ['Email', 'Password'],
    links: ['/signup', '/forgot-password'],
  },
  {
    path: '/signup',
    name: 'signup',
    heading: /create your workspace/i,
    submit: /^create account$/i,
    fields: ['Email', 'Password'],
    links: ['/login', '/terms', '/privacy'],
  },
  {
    path: '/forgot-password',
    name: 'forgot password',
    heading: /reset|forgot/i,
    submit: /send reset link/i,
    fields: ['Email'],
    links: ['/login'],
  },
];

for (const screen of SCREENS) {
  test.describe(screen.name, () => {
    test('renders its form', async ({ page }) => {
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));

      await page.goto(screen.path);
      await expect(page.getByRole('heading', { name: screen.heading }).first()).toBeVisible();

      for (const field of screen.fields) {
        await expect(
          byLabel(page, field),
          `${screen.name} lost its ${field} field`
        ).toBeVisible();
      }

      await expect(page.getByRole('button', { name: screen.submit })).toBeVisible();
      expect(errors, `uncaught errors on ${screen.path}:\n${errors.join('\n')}`).toEqual([]);
    });

    test('keeps its links to the other auth screens', async ({ page }) => {
      await page.goto(screen.path);
      for (const href of screen.links) {
        await expect(
          page.locator(`a[href="${href}"]`).first(),
          `${screen.name} lost its link to ${href}`
        ).toBeVisible();
      }
    });

    test('accepts typing into every field', async ({ page }) => {
      // Guards the exact defect CLAUDE.md records for Modal/Drawer: an effect
      // that re-focuses on every render sends the second keystroke nowhere. A
      // re-theme that reintroduces it would look perfect and be unusable.
      await page.goto(screen.path);
      for (const field of screen.fields) {
        const input = byLabel(page, field);
        await input.fill('');
        await input.type('abcdefgh', { delay: 20 });
        await expect(input, `${field} dropped characters while typing`).toHaveValue('abcdefgh');
      }
    });
  });
}

test('login offers the third-party providers and the email-link alternative', async ({ page }) => {
  await page.goto('/login');
  // Google and GitHub are how most people actually get in; losing the buttons
  // in a re-theme is invisible to a screenshot diff of the email form.
  await expect(page.getByRole('button', { name: /google/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /github/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /email me a sign-in link/i })).toBeVisible();
});

test('signup refuses to submit invalid input', async ({ page }) => {
  await page.goto('/signup');
  await byLabel(page, 'Email').fill('not-an-email');
  await byLabel(page, 'Password').fill('short');
  await page.getByRole('button', { name: /^create account$/i }).click();

  // Validation here is the browser's own: the email field is type=email and
  // required, so constraint validation blocks submission before React's
  // handler runs and no role=alert is ever rendered. Asserting on an alert
  // would be asserting on an implementation that does not exist.
  //
  // What matters for a re-theme is the observable outcome: a malformed address
  // must not navigate anywhere. If a re-theme drops type=email or required,
  // the submit proceeds and this fails - which is exactly the regression.
  await page.waitForTimeout(2_000);
  expect(page.url(), 'an invalid signup was allowed to proceed').toContain('/signup');

  const email = byLabel(page, 'Email');
  const valid = await email.evaluate(el => el.validity.valid);
  expect(valid, 'the email field no longer rejects a malformed address').toBe(false);
});
