/**
 * Where the signed-in test account's workspace lives, as recorded by
 * `npm run login`.
 *
 * Read from disk rather than resolved by visiting /app, because /app has a
 * cold-load bug (see the bookmarkable-entry-points tests). A shared fixture
 * that trips over a known defect takes every authed spec down with it, instead
 * of failing only the test that is about that defect.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, '.auth', 'workspace.json');

export function workspaceRoot() {
  if (!fs.existsSync(FILE)) {
    throw new Error('No .auth/workspace.json — run `npm run login` first.');
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8')).path;
}
