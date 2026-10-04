import { PRERENDERED_ROUTES as PAGE_ROUTES } from './seo.js';
import { BLOG_META } from './blog.js';
import { COMPARISONS, ALTERNATIVES } from '../content/compare.js';
import { AGENT_PAGES } from '../content/agents.js';

/**
 * Every public page the build writes and the sitemap lists, and the metadata
 * of the ones whose title lives beside their content (4 Oct 2026).
 *
 * lib/seo.js holds the hand-written pages and must stay importable by plain
 * Node; this module needs the bundler (the blog is an `import.meta.glob`), so
 * it is read through the SSR build by scripts/prerender.mjs and directly by
 * the SPA's PageMeta. A post, comparison or agent page added to its content
 * file is prerendered, titled and in the sitemap with no other change.
 */

const COMPARE_META = Object.fromEntries(COMPARISONS.map(c => [
  `/compare/${c.slug}`, { title: c.title, description: c.description },
]));

const ALTERNATIVE_META = Object.fromEntries(ALTERNATIVES.map(a => [
  `/alternatives/${a.slug}`, { title: a.title, description: a.description },
]));

const AGENT_META = Object.fromEntries(AGENT_PAGES.map(p => [
  p.path, { title: p.title, description: p.description },
]));

export const CONTENT_META = { ...COMPARE_META, ...ALTERNATIVE_META, ...AGENT_META, ...BLOG_META };

export const ALL_ROUTES = [...PAGE_ROUTES, ...Object.keys(CONTENT_META)];
