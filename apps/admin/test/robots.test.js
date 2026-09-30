/**
 * The console is never indexed. Three mechanisms, all static, all pinned:
 * a header for crawlers that read headers, a robots.txt for ones that ask
 * first, and the meta tag in index.html for ones that read the document.
 * Static rather than generated because there is no environment branch — a
 * staff console has no prod in which indexing would be right.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

describe('search-engine indexing is refused', () => {
  it('by a robots.txt that disallows everything', () => {
    expect(read('public/robots.txt')).toBe('User-agent: *\nDisallow: /\n');
  });

  it('by X-Robots-Tag on every path', () => {
    const rules = read('public/_headers')
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(rules[0]).toBe('/*');
    expect(rules).toContain('  X-Robots-Tag: noindex, nofollow');
  });

  it('by a robots meta tag in the document', () => {
    expect(read('index.html')).toMatch(/<meta name="robots" content="noindex, nofollow" \/>/);
  });
});
