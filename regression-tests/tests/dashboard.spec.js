/**
 * Every screen behind the workspace gate.
 *
 * This is the half of the product the re-theme restructures most: today's left
 * sidebar becomes a top tab bar. The navigation *shape* is allowed to change —
 * the brief says so explicitly. What may not change is that all eleven
 * destinations remain reachable, render their own content, and keep the
 * controls that do the work.
 *
 * Runs under the session `npm run login` saved.
 */

import { test, expect } from '@playwright/test';
import { workspaceRoot } from '../lib-ws.mjs';

/**
 * The eleven workspace routes from App.jsx, each with something only that
 * screen shows. `label` is the nav entry that must still lead there — whether
 * that nav is a sidebar or a tab bar is the re-theme's business.
 */
const SCREENS = [
  // `Overview`, not `Dashboard` — the nav entry was renamed, and the marker is
  // "Quick start" because the four stat tiles this used to look for (/storage
  // used/i) moved out of <main> and into the shell, where they now sit above
  // the tab bar on every screen. A marker inside the shell would pass on all
  // eleven routes, which is the opposite of what this table is for.
  { sub: '', name: 'overview', label: 'Overview', expect: /quick start/i },
  { sub: '/files', name: 'files', label: 'Files', expect: /sort:/i },
  { sub: '/activity', name: 'activity', label: 'Activity', expect: /actor:/i },
  { sub: '/agents', name: 'agents', label: 'Agent identities', expect: /identities your ai systems use/i },
  { sub: '/keys', name: 'keys', label: 'API keys', expect: /each key carries its own scope/i },
  { sub: '/mcp', name: 'mcp', label: 'MCP connection', expect: /model context protocol/i },
  { sub: '/webhooks', name: 'webhooks', label: 'Webhooks', expect: /outbound notifications/i },
  { sub: '/usage', name: 'usage', label: 'Usage', expect: /resets in/i },
  { sub: '/settings', name: 'settings', label: 'Settings', expect: /workspace configuration/i },
  { sub: '/profile', name: 'profile', label: null, expect: /activity log/i },
];

test.describe('workspace screens', () => {
  const ws = workspaceRoot();

  for (const screen of SCREENS) {
    test(`${screen.name} renders`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));

      await page.goto(`${ws}${screen.sub}`);

      // Assert against <main>, not <body>. The shell's nav lists every screen's
      // name, so a body-level match is satisfied by the sidebar alone and would
      // pass for a screen whose content never arrived.
      const main = page.locator('main').first();

      // Poll rather than read once. A screen's title renders before its body,
      // so a single innerText read can catch a half-built page and report an
      // "empty screen" for a screen that renders perfectly a moment later.
      // The smallest real screen is ~180 characters; 120 is a safe floor.
      await expect
        .poll(async () => (await main.innerText()).trim().length, { timeout: 25_000 })
        .toBeGreaterThan(120);

      await expect(main, `${screen.name} never rendered its own content`)
        .toContainText(screen.expect, { timeout: 15_000 });

      expect(errors, `uncaught errors on ${screen.name}:\n${errors.join('\n')}`).toEqual([]);
    });
  }

  test('every destination is reachable by activating its nav entry', async ({ page }) => {
    // Activation, not hrefs. The shell's nav items are rendered as <a href="#">
    // and navigate through an onNavigate handler, so there is no href to assert
    // against — see the 'primary navigation is not real links' test below.
    //
    // Clicking by accessible name is also the assertion that survives the
    // re-theme: sidebar or tab bar, the entry must still be findable by its
    // name and must still land on the right URL.
    for (const screen of SCREENS.filter(s => s.label)) {
      await page.goto(ws);
      const entry = page.getByRole('link', { name: screen.label, exact: true })
        .or(page.getByRole('button', { name: screen.label, exact: true }))
        .or(page.getByRole('tab', { name: screen.label, exact: true }))
        .first();

      await expect(entry, `no nav entry named "${screen.label}"`)
        .toBeVisible({ timeout: 15_000 });
      await entry.click();

      // Exact pathname rather than a regex: it is stricter (the overview
      // path is a prefix of every other) and needs no escaping.
      await expect
        .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
        .toBe(ws + screen.sub);
    }
  });

  test('primary navigation is real links', async ({ page }) => {
    // KNOWN PRE-EXISTING FAILURE, recorded rather than hidden.
    //
    // Every sidebar entry renders as <a href="#"> and navigates through JS. The
    // consequences are ordinary and real: middle-click and ctrl-click do not
    // open a screen in a new tab, "Copy link address" yields "#", and a screen
    // reader announces nine links all pointing at the same place.
    //
    // It is recorded here because the re-theme rebuilds this exact component —
    // sidebar becomes tab bar — which is the natural moment to give the entries
    // their real destinations. Fails at baseline, so it never blocks the merge.
    await page.goto(ws);
    // Wait for the shell to actually render before counting. Counting straight
    // after goto returns 0 and passes this test for the wrong reason — which is
    // exactly the false green a regression suite must not produce.
    await expect(page.getByRole('link', { name: 'Files', exact: true }))
      .toBeVisible({ timeout: 20_000 });

    const hashLinks = await page.locator('a[href="#"]').count();
    expect(
      hashLinks,
      `${hashLinks} navigation entries render as <a href="#"> instead of real destinations`
    ).toBe(0);
  });

  test('the account menu still offers sign-out', async ({ page }) => {
    await page.goto(ws);

    // Wait for the trigger rather than count() it. count() does not auto-wait,
    // so on a cold load it returns 0, the click is skipped, and the assertion
    // below fails for a menu that was never opened — which is what happened
    // here and looked exactly like a real regression.
    //
    // Absence of the control is a failure, not a reason to skip.
    const trigger = page.getByRole('button', { name: /account|profile|menu/i }).first();
    await expect(trigger, 'no account-menu control in the shell')
      .toBeVisible({ timeout: 20_000 });
    await trigger.click();

    await expect(
      page.getByRole('menuitem', { name: /sign out|log out/i })
        .or(page.getByRole('button', { name: /sign out|log out/i }))
        .first(),
      'the account menu opened but offers no way to sign out'
    ).toBeVisible({ timeout: 10_000 });
  });

  test('the workspace switcher still lists a workspace', async ({ page }) => {
    await page.goto(ws);
    const switcher = page.getByRole('button', { name: /workspace|switch/i }).first();
    await expect(switcher).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('primary actions still open', () => {
  const ws = workspaceRoot();

  /**
   * The product's three main create paths. Each test opens the form and checks
   * a real dialog with a real field appears — it never submits, so a run leaves
   * no state behind.
   *
   * The trigger names are the exact button labels, read from the deployed app.
   * An earlier draft guessed ("Create API key", "Add webhook") and, combined
   * with a count() that does not auto-wait, silently *skipped* all three rather
   * than failing — a skip in a baseline is a hole, not a pass.
   */
  const ACTIONS = [
    { sub: '/agents', trigger: 'Create agent', name: 'agent' },
    { sub: '/keys', trigger: 'Create key', name: 'API key' },
    { sub: '/webhooks', trigger: 'Add endpoint', name: 'webhook' },
  ];

  for (const action of ACTIONS) {
    test(`the ${action.name} create form opens`, async ({ page }) => {
      await page.goto(`${ws}${action.sub}`);

      const trigger = page.getByRole('button', { name: action.trigger, exact: true }).first();
      await expect(trigger, `no "${action.trigger}" control on ${action.sub}`)
        .toBeVisible({ timeout: 20_000 });
      await trigger.click();

      // A dialog that opens with no field in it is the "false success" failure
      // mode backlog/023 describes.
      const dialog = page.getByRole('dialog').first();
      await expect(dialog, `"${action.trigger}" opened no dialog`)
        .toBeVisible({ timeout: 10_000 });
      await expect(
        dialog.locator('input, textarea, select').first(),
        `the ${action.name} dialog opened with no input in it`
      ).toBeVisible({ timeout: 10_000 });
    });
  }

  test('a dialog accepts continuous typing and closes on Escape', async ({ page }) => {
    // The Modal/Drawer focus defect CLAUDE.md records, asserted end to end.
    // The effect that focuses a field had onClose in its dependency array, and
    // every call site passes an inline arrow, so it re-ran on each keystroke and
    // threw focus back to the header's close button — typing one character into
    // any dialog sent the next character nowhere.
    await page.goto(`${ws}/agents`);

    const trigger = page.getByRole('button', { name: 'Create agent', exact: true }).first();
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    await trigger.click();

    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    const field = dialog.locator('input[type="text"], input:not([type])').first();
    await field.click();
    await field.pressSequentially('regression-typing-test', { delay: 25 });
    await expect(field, 'the dialog stole focus mid-typing').toHaveValue('regression-typing-test');

    await page.keyboard.press('Escape');
    await expect(dialog, 'Escape did not close the dialog').toBeHidden({ timeout: 10_000 });
  });
});

test.describe('bookmarkable entry points', () => {
  /**
   * KNOWN PRE-EXISTING FAILURE, recorded rather than hidden.
   *
   * A cold document load of /app or /dashboard while signed in bounces to
   * /login. WorkspaceProvider.refresh() runs before Firebase has restored the
   * session, sees no user, and sets loading false (lib/workspace.jsx). When the
   * session then arrives, CurrentWorkspaceRedirect renders with loading already
   * false and workspaceId still null, so App.jsx redirects to /login before the
   * re-fetch can begin.
   *
   * It matters because App.jsx's own comment calls /dashboard "the shareable
   * spelling" — the path a bookmark, a support article or a link to a colleague
   * would use. Following one while signed in lands on a sign-in screen.
   *
   * The in-app client-side route works, which is why this is invisible in
   * normal use and only shows up on a fresh load.
   *
   * Fails at baseline, so it can never block this migration. It is here so the
   * migration does not quietly inherit it as expected behaviour — and because
   * the fix lives in App.jsx, which the re-theme edits anyway.
   */
  for (const path of ['/app', '/dashboard']) {
    test(`a cold load of ${path} reaches a workspace, not the login screen`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(12_000);

      const landed = new URL(page.url()).pathname;
      expect(
        landed,
        `a signed-in cold load of ${path} bounced to ${landed}`
      ).toMatch(/^\/w\//);
    });
  }
});
