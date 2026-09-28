// @vitest-environment node
/**
 * The marketing routes render to HTML under Node, with no `window`.
 *
 * This is what `scripts/prerender.mjs` does at build time, run here as a
 * test so that a component which starts reading a browser global at render
 * fails the suite instead of the deploy. The environment is Node on purpose:
 * jsdom would hand every component a `window` and prove nothing.
 */

import { describe, expect, it } from 'vitest';
import { PRERENDERED_ROUTES, render } from '../src/entry-prerender.jsx';

const EXPECTED = {
  '/': 'Storage your agents can actually reason about.',
  '/pricing': 'Pay for storage. Nothing else.',
  '/docs': 'AgentDisk documentation'
};

describe('prerender', () => {
  it('covers exactly the public marketing routes', () => {
    expect(PRERENDERED_ROUTES).toEqual(Object.keys(EXPECTED));
  });

  for (const [route, heading] of Object.entries(EXPECTED)) {
    it(`renders ${route} to a page carrying its heading, with no window`, () => {
      expect(typeof window).toBe('undefined');
      const html = render(route);
      expect(html).toContain(heading);
      // A page, not a nav with an empty main.
      expect(html.length).toBeGreaterThan(4000);
    });
  }

  it('renders each route to different content', () => {
    const pages = PRERENDERED_ROUTES.map(render);
    expect(new Set(pages).size).toBe(pages.length);
  });
});
