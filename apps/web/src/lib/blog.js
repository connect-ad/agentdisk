import { parseFrontmatter, parseBlocks, splitFaq, readingMinutes } from './markdown.js';

/**
 * The blog, read from `src/content/blog/*.md` at build time (4 Oct 2026).
 *
 * `import.meta.glob` with `eager` puts every post into the bundle, which is
 * what lets the prerender render each one synchronously and lets the post
 * list, the related posts and the sitemap all come from one directory: adding
 * a post is adding a file. The posts are text, a few kilobytes each
 * compressed.
 *
 * `{{API_BASE}}` and `{{MCP_ENDPOINT}}` in a post are this build's API, as
 * the docs' own snippets are, so a dev build shows dev's endpoint and prod's
 * shows prod's without a hostname typed into content.
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://api-dev.agentdisk.io';

const files = import.meta.glob('../content/blog/*.md', { query: '?raw', import: 'default', eager: true });

function substitute(text) {
  return text.replaceAll('{{MCP_ENDPOINT}}', `${API_BASE}/mcp`).replaceAll('{{API_BASE}}', API_BASE);
}

function load(path, source) {
  const { data, body } = parseFrontmatter(substitute(source));
  const fileSlug = path.split('/').pop().replace(/\.md$/, '');
  const { body: blocks, faq } = splitFaq(parseBlocks(body));
  return {
    slug: data.slug || fileSlug,
    title: data.title || fileSlug,
    description: data.description || '',
    date: data.date || '',
    author: data.author || 'AgentDisk team',
    tags: data.tags || [],
    keywords: data.keywords || [],
    minutes: readingMinutes(body),
    blocks,
    faq,
  };
}

/** Every post, newest first; a tie goes to the title, so the order is stable. */
export const POSTS = Object.entries(files)
  .map(([path, source]) => load(path, source))
  .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));

export const POSTS_PER_PAGE = 10;

export function postBySlug(slug) {
  return POSTS.find(p => p.slug === slug) ?? null;
}

/** Up to `n` other posts, by tags in common, then newest. */
export function relatedPosts(post, n = 3) {
  return POSTS
    .filter(p => p.slug !== post.slug)
    .map(p => ({ p, shared: p.tags.filter(t => post.tags.includes(t)).length }))
    .sort((a, b) => b.shared - a.shared || b.p.date.localeCompare(a.p.date))
    .slice(0, n)
    .map(x => x.p);
}

/** "4 October 2026" from "2026-10-04", without a timezone to shift it a day. */
export function formatDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return iso;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  return `${d} ${months[m - 1]} ${y}`;
}

/** The routes the prerender and the sitemap add for the posts. */
export const BLOG_ROUTES = POSTS.map(p => `/blog/${p.slug}`);

/**
 * Page metadata per post, in the shape lib/seo.js reads. The brand suffix is
 * dropped from a title it would push past 70 characters, the length a search
 * result shows; the post title itself is never cut.
 */
const withBrand = title => (`${title} — AgentDisk`.length <= 70 ? `${title} — AgentDisk` : title);

export const BLOG_META = Object.fromEntries(POSTS.map(p => [
  `/blog/${p.slug}`,
  { title: withBrand(p.title), description: p.description, type: 'article', published: p.date },
]));
