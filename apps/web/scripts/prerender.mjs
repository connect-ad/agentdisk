/**
 * Prerender the public marketing routes into `dist/` after `vite build`.
 *
 * Runs as the last step of `npm run build`. It compiles `src/entry-prerender.jsx`
 * for Node with Vite's SSR build, renders each route in `PRERENDERED_ROUTES`,
 * and writes the markup into a copy of the built `index.html`:
 *
 *   /         -> dist/index.html
 *   /pricing  -> dist/pricing.html
 *   /docs     -> dist/docs.html
 *
 * `pricing.html` rather than `pricing/index.html` because the asset server's
 * default `auto-trailing-slash` handling serves `pricing.html` at `/pricing`
 * with no redirect, and would redirect `/pricing` to `/pricing/` for the
 * directory form.
 *
 * Each page also gets `<meta name="agentdisk:prerendered" content="<route>">`
 * as the first head element, ahead of `prerender-guard.js`, which reads it to
 * decide whether the markup belongs to the URL being viewed. The smoke test
 * reads the same tag to prove the deployed site carries prerendered routes.
 *
 * Beside each page goes its markdown twin, `index.md`, `pricing.md` and
 * `docs.md`, converted from the same rendered markup by
 * `scripts/page-markdown.mjs`. `worker.js` serves it on the site host to a
 * request that asks for `text/markdown` (4 Oct 2026).
 *
 * Every failure throws: a build that quietly shipped the empty shell would be
 * the defect this script exists to remove.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { headTags } from '../src/lib/seo.js';
import { markdownFileFor, pageMarkdown } from './page-markdown.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const ssrDir = join(root, 'dist-ssr');

const MOUNT = '<div id="root"></div>';
/** The template's bare title, replaced per route by `headTags` (lib/seo.js). */
const TITLE = '<title>AgentDisk</title>';
const CHARSET = /<meta charset="utf-8"\s*\/?>/i;
/** A rendered route shorter than this is a blank page with a nav, not content. */
const MIN_BYTES = 4000;

await build({
  root,
  configFile: join(root, 'vite.config.js'),
  logLevel: 'warn',
  build: {
    ssr: 'src/entry-prerender.jsx',
    outDir: 'dist-ssr',
    emptyOutDir: true,
    sourcemap: false,
    minify: false
  }
});

const { render, PRERENDERED_ROUTES } = await import(
  pathToFileURL(join(ssrDir, 'entry-prerender.js')).href
);

const template = readFileSync(join(dist, 'index.html'), 'utf8');
if (!template.includes(MOUNT)) {
  throw new Error(`dist/index.html has no ${MOUNT} mount point; refusing to prerender into it`);
}
if (!CHARSET.test(template)) {
  throw new Error('dist/index.html has no <meta charset> to anchor the prerender marker on');
}
if (!template.includes(TITLE)) {
  throw new Error(`dist/index.html has no ${TITLE} to replace with the route's metadata`);
}

for (const route of PRERENDERED_ROUTES) {
  const html = render(route);
  if (html.length < MIN_BYTES) {
    throw new Error(`prerender of ${route} produced ${html.length} bytes; expected a page`);
  }
  const marker = `<meta name="agentdisk:prerendered" content="${route}" />`;
  const page = template
    .replace(CHARSET, match => `${match}\n    ${marker}`)
    .replace(TITLE, headTags(route))
    .replace(MOUNT, `<div id="root"><div data-prerendered="${route}">${html}</div></div>`);
  const file = route === '/' ? 'index.html' : `${route.slice(1)}.html`;
  writeFileSync(join(dist, file), page, 'utf8');
  console.log(`prerendered ${route} -> dist/${file} (${page.length} bytes)`);

  const markdown = pageMarkdown(route, html);
  const mdFile = markdownFileFor(route);
  writeFileSync(join(dist, mdFile), markdown, 'utf8');
  console.log(`prerendered ${route} -> dist/${mdFile} (${markdown.length} bytes)`);
}

rmSync(ssrDir, { recursive: true, force: true });
