/**
 * Mints the session the authed specs run under.
 *
 * Drives the real sign-in UI rather than calling Firebase's REST API directly.
 * That is deliberate: signing in is itself part of what a re-theme can break,
 * and a script that bypassed the form would happily produce a green suite for a
 * build whose login page no longer works. If this script cannot get in, that is
 * a regression finding, not a setup problem.
 *
 * Idempotent. It tries to sign in first; only if that fails does it go through
 * signup. Re-running against an existing account just refreshes the token.
 *
 * Writes .auth/state.json, which holds a live bearer token for the test
 * account - gitignored, and it should stay that way.
 *
 *   node scripts/login.mjs
 */

import { chromium } from '@playwright/test';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: path.join(here, '.env') });

const BASE_URL = process.env.BASE_URL || 'https://app-dev.agentdisk.io';
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;
const AUTH_DIR = path.join(here, '.auth');
const STATE = path.join(AUTH_DIR, 'state.json');

if (!EMAIL || !PASSWORD) {
  console.error(
    'TEST_EMAIL and TEST_PASSWORD must be set in regression-tests/.env\n' +
    'Copy .env.example to .env and fill them in.'
  );
  process.exit(1);
}

/** Input renders the required marker inside the label, so it reads "Email*". */
const byLabel = (page, field) => page.getByLabel(new RegExp('^' + field + '[*]?$'));

/** Anywhere that requires a session. */
const INSIDE = /^\/(w\/|app$|dashboard$|verify-email$)/;

/** Wait for the app to settle somewhere that requires a session. */
async function settled(page, ms) {
  try {
    await page.waitForURL(u => INSIDE.test(u.pathname), { timeout: ms });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for the app to land on a real workspace under its own steam.
 *
 * Deliberately does NOT navigate to /app to get there. A cold document load of
 * /app bounces a signed-in person to /login: WorkspaceProvider.refresh() runs
 * before Firebase has restored the session, sees no user, and sets loading
 * false; when the session then arrives, CurrentWorkspaceRedirect renders with
 * loading already false and workspaceId still null, so it redirects to /login
 * before the re-fetch can start. That is a real pre-existing bug (covered by a
 * test in dashboard.spec.js), not something this script should trip over.
 *
 * The client-side flow after sign-in reaches /w/... correctly, so just wait.
 */
async function reachWorkspace(page) {
  try {
    await page.waitForURL(u => u.pathname.startsWith('/w/'), { timeout: 45_000 });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'UTC' });
  const page = await context.newPage();

  console.log(`-> ${BASE_URL}`);

  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await byLabel(page, 'Email').fill(EMAIL);
  await byLabel(page, 'Password').fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // Sign-in is a network round trip to Firebase and then a client-side
  // redirect. Give it room rather than racing an alert against it.
  if (!(await settled(page, 30_000))) {
    const alert = await page.getByRole('alert').first().textContent().catch(() => null);
    console.log(`  sign-in did not land inside the app${alert ? `: ${alert.trim()}` : ''}`);
    console.log('-> creating the account through the signup form');

    await page.goto(`${BASE_URL}/signup`, { waitUntil: 'domcontentloaded' });
    await byLabel(page, 'Email').fill(EMAIL);
    await byLabel(page, 'Password').fill(PASSWORD);
    await page.getByRole('button', { name: /^create account$/i }).click();

    if (!(await settled(page, 40_000))) {
      const alert = await page.getByRole('alert').first().textContent().catch(() => null);
      throw new Error(
        `Could not sign in or sign up as ${EMAIL}.` +
        (alert ? ` The page said: ${alert.trim()}` : ' No error was shown.')
      );
    }
    console.log('  account created');
  }

  // Nothing gates on email verification - there is no emailVerified check
  // anywhere in the app - so a fresh signup can walk straight in.
  if (!(await reachWorkspace(page))) {
    throw new Error(
      `Signed in as ${EMAIL}, but /app never resolved to a workspace. ` +
      `Last URL: ${page.url()}`
    );
  }

  console.log(`  session reaches ${new URL(page.url()).pathname}`);

  // Record where the session actually lives so the specs never have to ask
  // /app for it. /app is exactly the route with the cold-load bug above, and
  // a shared fixture that trips over a known defect takes every authed spec
  // down with it rather than failing the one test that is about that defect.
  const workspacePath = new URL(page.url()).pathname;

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(AUTH_DIR, 'workspace.json'),
    JSON.stringify({ path: workspacePath, email: EMAIL }, null, 2)
  );
  await context.storageState({ path: STATE });
  console.log(`OK session saved to ${path.relative(process.cwd(), STATE)}`);

  await browser.close();
}

main().catch(err => {
  console.error(`\nFAILED ${err.message}`);
  process.exit(1);
});
