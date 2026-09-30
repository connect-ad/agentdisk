/**
 * One fresh app session per test.
 *
 * `resourceCache` is a module-level store, which is the point of it — a screen
 * revisited during a session must find what the last one fetched. Inside a test
 * file that is exactly wrong: every test mounts the same screens for the same
 * `ws_test` with its own mocked API, so without this the second test in a file
 * renders the first one's data and asserts against a fixture that was never
 * fetched.
 *
 * Here rather than in each test file, because a cache that has to be remembered
 * in twenty places is one that will be forgotten in the twenty-first.
 */

import { afterEach } from 'vitest';
import { clearCache } from '../src/lib/resourceCache.js';

afterEach(() => {
  clearCache();
});
