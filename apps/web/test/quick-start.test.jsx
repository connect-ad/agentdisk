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
 * that rendered the cards and counted them would have passed throughout.
 *
 * So the assertions here are about the *sequence*, not the markup:
 *
 *   - every step goes to a route that is actually in the nav, because a step
 *     is a link and a link to nowhere is worse than no step;
 *   - the identity is created before the key is minted, because `agent_id` is
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
 * The quick-start array only, so a `to:` anywhere else on the Overview screen
 * — the usage alert's "Review usage", the "View all" beside Recent files —
 * cannot be mistaken for a step.
 */
const block = (() => {
  const start = dashboard.indexOf('<div className="ds__quick">');
  const end = dashboard.indexOf('].map(q => (', start);
  expect(start, 'the quick-start grid is still on Overview').toBeGreaterThan(-1);
  expect(end, 'the quick-start array still ends with .map').toBeGreaterThan(start);
  return dashboard.slice(start, end);
})();

const all = (source, re) => [...source.matchAll(re)].map(m => m[1]);

const titles = all(block, /title: '([^']+)'/g);
const destinations = all(block, /to: `\$\{root\}([^`]*)`/g);

/* Every `path:` in NAV, which is what a `${root}`-relative link resolves
   against. '' is Overview and is a legitimate destination. */
const navPaths = all(app.slice(app.indexOf('export const NAV')), /path: '([^']*)'/g);

describe('the quick start walks a real path through the product', () => {
  it('numbers its steps consecutively from one', () => {
    expect(all(block, /n: '([^']+)'/g)).toEqual(
      titles.map((_, i) => String(i + 1))
    );
  });

  it('sends every step somewhere the nav actually goes', () => {
    expect(destinations.length).toBe(titles.length);
    for (const to of destinations) {
      expect(navPaths, `quick start links to ${to || '/'}`).toContain(to);
    }
  });

  it('creates the agent identity before minting the key for it', () => {
    const agents = destinations.indexOf('/agents');
    const keys = destinations.indexOf('/keys');

    // Both present at all is half the assertion: dropping the agent step is
    // precisely the regression, and indexOf would return -1 for it, which
    // sorts before everything and would pass a naive ordering check.
    expect(agents, 'a step introduces agent identities').toBeGreaterThan(-1);
    expect(keys, 'a step mints a key').toBeGreaterThan(-1);
    expect(agents).toBeLessThan(keys);
  });

  it('lays out one column per step, so none of them wraps alone', () => {
    const css = read('src/app.css');
    const grid = /\.ds__quick\{display:grid;grid-template-columns:repeat\((\d)/.exec(css);

    expect(grid, '.ds__quick still declares an explicit column count').not.toBeNull();
    expect(Number(grid[1])).toBe(titles.length);
  });
});
