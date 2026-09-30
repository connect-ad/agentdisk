/**
 * The Overview quick start, against the nav it walks somebody through.
 *
 * It used to run: create a key, connect over MCP, "give an agent a folder".
 * Three steps, and the last one named an agent that no earlier step had told
 * anybody to create. The one nav entry sitting between Files and API keys —
 * Agent identities — was the one the walkthrough skipped, so the product's
 * central idea was the thing a new account was never introduced to.
 *
 * Nothing broke, which is why it survived: `keys.agent_id` is nullable and the
 * create-key modal offers "No agent (workspace-level)", so following the old
 * steps left you holding a working credential attributed to nobody. A test
 * that rendered the steps and counted them would have passed throughout.
 *
 * So the assertions here are about the *sequence*, not the markup:
 *
 *   - every step goes to a route that is actually in the nav, because the
 *     next step carries a link and a link to nowhere is worse than no step;
 *   - the agent is created before the key is minted, because `agent_id` is
 *     set when a key is created and there is no screen that re-attributes one
 *     afterwards — get that order wrong and the walkthrough produces exactly
 *     the anonymous key this fix exists to prevent.
 *
 * Read as text rather than rendered: importing App.jsx to reach NAV pulls
 * every route in the product into a jsdom suite to check two string lists.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = p => readFileSync(resolve(process.cwd(), p), 'utf8');

const dashboard = read('src/routes/Dashboard.jsx');
const app = read('src/App.jsx');

/**
 * The STEPS array only, so a `to:` anywhere else on the Overview screen — the
 * usage alert's "Review usage", the "View all" beside Recent files — cannot be
 * mistaken for a step.
 */
const block = (() => {
  const start = dashboard.indexOf('const STEPS = [');
  const end = dashboard.indexOf('];', start);
  expect(start, 'STEPS is still declared in Dashboard.jsx').toBeGreaterThan(-1);
  expect(end, 'STEPS is still an array literal').toBeGreaterThan(start);
  return dashboard.slice(start, end);
})();

const all = (source, re) => [...source.matchAll(re)].map(m => m[1]);

const titles = all(block, /title: '([^']+)'/g);
const destinations = all(block, /to: '([^']*)'/g);

/* Every `path:` in NAV, which is what a workspace-relative `to` resolves
   against. '' is Overview and is a legitimate destination. */
const navPaths = all(app.slice(app.indexOf('export const NAV')), /path: '([^']*)'/g);

describe('the quick start walks a real path through the product', () => {
  it('sends every step somewhere the nav actually goes', () => {
    expect(titles.length).toBeGreaterThan(0);
    expect(destinations.length).toBe(titles.length);
    for (const to of destinations) {
      expect(navPaths, `quick start links to ${to || '/'}`).toContain(to);
    }
  });

  it('creates the agent before minting the key for it', () => {
    const agents = destinations.indexOf('/agents');
    const keys = destinations.indexOf('/keys');

    // Both present at all is half the assertion: dropping the agent step is
    // precisely the regression, and indexOf would return -1 for it, which
    // sorts before everything and would pass a naive ordering check.
    expect(agents, 'a step creates the agent').toBeGreaterThan(-1);
    expect(keys, 'a step mints a key').toBeGreaterThan(-1);
    expect(agents).toBeLessThan(keys);
  });

  it('lays out one column per step, so the arrows between them mean something', () => {
    // The arrow into each box is drawn in the grid gap to its left, which only
    // reads as "then" while every step sits on one row. A fifth step in a
    // four-column grid would wrap under the first with an arrow pointing at
    // the margin.
    const css = read('src/app.css');
    const grid = /\.ds__qs\{[^}]*grid-template-columns:repeat\((\d)/.exec(css);

    expect(grid, '.ds__qs still declares an explicit column count').not.toBeNull();
    expect(Number(grid[1])).toBe(titles.length);
  });

  it('ticks a step only once the one before it is done', () => {
    // The dependency the list draws has to be the dependency it computes. A
    // used workspace-level key must not tick "connect it" over an unticked
    // "create a key" — that would be a sequence saying you are past a step
    // you have not done.
    const start = dashboard.indexOf('function stepsDone(');
    const end = dashboard.indexOf('\n}\n', start);
    const fn = dashboard.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(fn).toMatch(/done\[i - 1\]/);
  });
});
