/**
 * The markdown twin of a prerendered page, for `Accept: text/markdown`.
 *
 * `scripts/prerender.mjs` writes `index.md`, `pricing.md` and `docs.md` next
 * to the HTML files, from the same rendered markup, and `worker.js` serves
 * one of them when an agent asks for markdown on the site host. Cloudflare's
 * zone-level Markdown for Agents does the same conversion at the edge, but it
 * needs the Pro plan and the zone is on Free; converting at build costs
 * nothing per request and the output can be read in `dist/` before it ships.
 *
 * The page chrome that carries no content for a reader without a browser -
 * the nav, icons, buttons, form controls - is dropped before conversion. The
 * title, description and canonical URL go in a front-matter block, the same
 * shape Cloudflare's converter emits.
 */

import { NodeHtmlMarkdown } from 'node-html-markdown';
import { SITE_ORIGIN, metaFor } from '../src/lib/seo.js';

/** Elements removed with everything inside them. */
const DROP = ['nav', 'svg', 'button', 'input', 'select', 'textarea', 'label', 'script', 'style', 'noscript'];

/**
 * Sibling spans that CSS lays out as chips or rows (the hero tags, a plan's
 * feature list, a price and its unit) have no whitespace between them in the
 * markup, so without CSS they read as one word: "1 GB storage1 agent
 * identity". A span directly followed by another element with text gets the
 * separator the page already uses in its eyebrows. Never inside a code
 * block, where the spans are terminal lines and the text is verbatim.
 */
const INLINE = new Set(['SPAN', 'A', 'STRONG', 'B', 'EM', 'I', 'CODE', 'SMALL']);
const hasText = node => node.textContent.trim() !== '';
const inCode = node => {
  for (let up = node.parentNode; up; up = up.parentNode) {
    if (up.tagName === 'PRE' || up.tagName === 'CODE') return true;
  }
  return false;
};
const separatedSpan = ({ node }) => {
  const next = node.nextSibling;
  const adjacent = next && INLINE.has(next.tagName) && hasText(next);
  return adjacent && hasText(node) && !inCode(node) ? { postfix: ' · ' } : {};
};

const converter = new NodeHtmlMarkdown(
  { ignore: DROP, bulletMarker: '-', maxConsecutiveNewlines: 2 },
  { span: separatedSpan }
);

/** Front matter values are quoted; a double quote inside one is escaped. */
const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function pageMarkdown(route, html) {
  const { title, description } = metaFor(route);
  const url = route === '/' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${route}`;
  const body = converter.translate(html).trim();
  return ['---', `title: ${quote(title)}`, `description: ${quote(description)}`, `url: ${url}`, '---', '', body, ''].join('\n');
}

/** `/` -> `index.md`, `/pricing` -> `pricing.md`. The name worker.js asks the assets for. */
export function markdownFileFor(route) {
  return route === '/' ? 'index.md' : `${route.slice(1)}.md`;
}
