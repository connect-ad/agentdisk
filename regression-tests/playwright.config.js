/**
 * Regression suite config.
 *
 * The suite exists to answer one question: **did a change to how the dashboard
 * looks break how it works?** Everything here follows from that.
 *
 * `BASE_URL` is the only thing that varies between a baseline run and a
 * verification run. Baseline is `app-dev`; verification is the preview Worker.
 * Nothing else changes, so a diff in results is a diff in the build.
 *
 * Two projects, and the split matters. `public` runs with no stored session,
 * because half the surface under test (landing, pricing, docs, the auth screens,
 * the error pages) is what a signed-out stranger sees — running those with a
 * session would silently skip the redirect behaviour they exist to check.
 * `authed` loads the storageState that `npm run login` wrote.
 *
 * Retries are 0 on purpose. A flaky pass is worse than a fail here: the whole
 * point is comparing two runs, and a retry turns "intermittently broken" into
 * "green", which is the one outcome that makes the comparison lie.
 */

import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '.env') });

const BASE_URL = process.env.BASE_URL || 'https://app-dev.agentdisk.io';
const STORAGE_STATE = path.join(here, '.auth', 'state.json');

export default defineConfig({
  testDir: path.join(here, 'tests'),
  // A live site over the public internet; the default 30s is tight for a cold
  // Worker plus a Firebase round trip.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  // Serial. The authed specs share one workspace on a real deployment; running
  // them in parallel means one spec's upload races another's file listing.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(here, 'test-results', 'results.json') }],
    ['html', { outputFolder: path.join(here, 'playwright-report'), open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // The suite asserts on accessible names and roles throughout. Setting this
    // explicitly keeps a locale-dependent date or number format from being the
    // reason a run differs from its baseline.
    locale: 'en-GB',
    timezoneId: 'UTC',
  },
  projects: [
    {
      name: 'public',
      testMatch: /(public|auth-screens|error-pages|security)\.spec\.js/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'authed',
      testMatch: /(dashboard|workspace)\.spec\.js/,
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE },
    },
  ],
});

export { BASE_URL, STORAGE_STATE };
