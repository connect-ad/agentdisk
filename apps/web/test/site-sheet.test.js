/**
 * The public site's sheet and gutter.
 *
 * Both assertions here guard the same failure: a second definition of a
 * dimension that already has one. That is not hypothetical — before this
 * change the nav was inset `--s-8`, the content beside it `--s-10`, and two
 * media queries re-stated the content's inset by hand at the exact
 * breakpoints `--gutter` already steps at. Nothing was broken enough to
 * notice, and the brand simply did not line up with the `h1` beneath it.
 *
 * These are text assertions against the stylesheet because the thing being
 * protected *is* the stylesheet's wording. jsdom computes no cascade, and a
 * rendering test would pass just as happily against two insets that agree by
 * coincidence today.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/app.css'), 'utf8');

/** The body of every `@media (min-width:N)` block whose N matches. */
function mediaBlocks(css, query) {
  const blocks = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(`@media ${query}`, from);
    if (start === -1) return blocks;
    const open = css.indexOf('{', start);
    let depth = 0;
    let i = open;
    for (; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(css.slice(open + 1, i));
    from = i;
  }
}

/** The declaration block of a top-level rule, by exact selector. */
function rule(css, selector) {
  const at = css.indexOf(`\n${selector}{`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(at + selector.length + 2, css.indexOf('}', at));
}

describe('the public site shares one gutter', () => {
  it('insets the nav and the content beneath it with the same token', () => {
    expect(rule(css, '.mk__nav')).toContain('padding:0 var(--gutter)');
    expect(rule(css, '.mk__wrap')).toContain('padding:0 var(--gutter)');
  });

  it('states that inset exactly once, never re-stated per breakpoint', () => {
    // --gutter already steps at 1350 and 875. A .mk__wrap padding inside any
    // media query is a second definition of the same dimension.
    const overrides = css.match(/\.mk__wrap\{[^}]*padding/g) ?? [];
    expect(overrides).toHaveLength(1);
  });
});

describe('the public site stands on a sheet', () => {
  it('draws the edge only where there is ground to stand off', () => {
    const desktop = mediaBlocks(css, '(min-width:1351px)').join('\n');
    expect(desktop).toMatch(/\.mk\{[^}]*border:1px solid var\(--line\)/);
    expect(desktop).toMatch(/\.mk\{[^}]*border-radius:var\(--r-4\)/);
    // Below the gate the sheet fills the frame, so no edge outside the block.
    expect(rule(css, '.mk')).not.toContain('border:');
  });

  it('gives the stage gap back to min-height, so two margins add no scrollbar', () => {
    const desktop = mediaBlocks(css, '(min-width:1351px)').join('\n');
    expect(desktop).toMatch(/\.mk\{[^}]*margin-block:var\(--sheet-gap\)/);
    expect(desktop).toMatch(/min-height:calc\(100vh - \(2 \* var\(--sheet-gap\)\)\)/);
  });

  it('cuts the corner on the children that paint their own background', () => {
    // Not overflow:hidden — that makes the sheet a scroll container and
    // .mk__nav, .doc__toc and .doc__rail all stop sticking.
    expect(rule(css, '.mk')).not.toContain('overflow:hidden');
    const desktop = mediaBlocks(css, '(min-width:1351px)').join('\n');
    expect(desktop).toMatch(/\.mk__nav\{border-radius:var\(--r-4\) var\(--r-4\) 0 0\}/);
    expect(desktop).toMatch(/\.mk__foot\{border-radius:0 0 var\(--r-4\) var\(--r-4\)\}/);
  });

  it('caps the column once, on the sheet rather than again inside it', () => {
    expect(rule(css, '.mk')).toContain('max-width:var(--shell-w)');
    expect(rule(css, '.mk__wrap')).not.toContain('max-width');
  });
});
