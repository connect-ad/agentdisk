/**
 * Per-route page metadata: one table, read from two places.
 *
 * `scripts/prerender.mjs` writes `headTags(route)` into each prerendered
 * page at build time, which is what a crawler, a social preview or an agent
 * with an HTTP tool sees. `applyPageMeta(pathname)` sets the same values on
 * the live document as the SPA navigates, which is what a tab title and a
 * JavaScript-rendering crawler see. Both read `PAGE_META`, so the title a
 * search result shows cannot differ from the one the tab shows.
 *
 * Plain JavaScript with no imports on purpose: Node imports this file
 * directly during the build, outside Vite, so nothing here may use JSX,
 * `import.meta.env` or a browser global at module scope.
 *
 * `SITE_ORIGIN` is production, in every environment. Only prod may be
 * indexed (see `scripts/security-headers.js`), and a staging page whose
 * canonical points at production is the standard way to say "the real one
 * is over there" if a crawler ever gets past the noindex.
 */

export const SITE_ORIGIN = 'https://app.agentdisk.io';
export const SITE_NAME = 'AgentDisk';

/** The one image the site has. A 1200×630 social card would be better; this is what exists. */
export const SOCIAL_IMAGE = `${SITE_ORIGIN}/agentdisk-logo.png`;

export const DEFAULT_META = {
  title: 'AgentDisk',
  description:
    'File storage built for AI agents: scoped, persistent workspaces for files, folders and metadata over REST and MCP, with an audit log you keep.'
};

export const PAGE_META = {
  '/': {
    title: 'AgentDisk — file storage built for AI agents',
    description:
      'Give every AI agent a scoped, persistent workspace for files, folders and metadata, over a REST API and an MCP server. You keep the audit log.'
  },
  '/pricing': {
    title: 'Pricing — AgentDisk',
    description:
      'Pay for storage and nothing else. Every plan includes the MCP server, webhooks, path-scoped keys and the full audit log, with unlimited requests.'
  },
  '/docs': {
    title: 'Documentation — AgentDisk',
    description:
      'How to give an AI agent a disk: connect Claude, Cursor or any MCP client, use the REST API, and see exactly how your data is kept, deleted and protected.'
  }
};

/** The table entry for a pathname, or the default for anything not listed. */
export function metaFor(pathname) {
  const path = (pathname || '/').replace(/\/+$/, '') || '/';
  return PAGE_META[path] ?? DEFAULT_META;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The head markup for a prerendered route, as one string.
 *
 * Replaces the template's bare `<title>`. Canonical and og:url are absolute
 * and point at production. The JSON-LD is only on the homepage and describes
 * the product, not its prices — those live in Stripe and the catalogue and
 * would go stale here.
 */
export function headTags(route) {
  const meta = metaFor(route);
  const url = `${SITE_ORIGIN}${route === '/' ? '/' : route}`;
  const tags = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${SOCIAL_IMAGE}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`,
    `<meta name="twitter:image" content="${SOCIAL_IMAGE}" />`
  ];
  if (route === '/') {
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: SITE_NAME,
      url: SITE_ORIGIN,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Any',
      description: meta.description
    };
    // `</` cannot appear inside a script element; JSON.stringify never
    // emits it from this object, but the replace keeps that true if a
    // description ever contains one.
    tags.push(
      `<script type="application/ld+json">${JSON.stringify(ld).replace(/<\//g, '<\\/')}</script>`
    );
  }
  return tags.join('\n    ');
}

function upsert(selector, create, attr, value) {
  let el = document.head.querySelector(selector);
  if (!el) {
    el = create();
    document.head.appendChild(el);
  }
  el.setAttribute(attr, value);
}

function upsertMeta(kind, name, content) {
  upsert(
    `meta[${kind}="${name}"]`,
    () => {
      const el = document.createElement('meta');
      el.setAttribute(kind, name);
      return el;
    },
    'content',
    content
  );
}

/**
 * Set the live document's title and description tags for a pathname.
 *
 * Called from an effect on every navigation. Idempotent: it updates the tags
 * the prerender wrote rather than adding a second set. Routes not in the
 * table get the defaults, so a dashboard tab reads "AgentDisk" rather than
 * the homepage's headline the fallback shell was built with.
 */
export function applyPageMeta(pathname) {
  if (typeof document === 'undefined') return;
  const meta = metaFor(pathname);
  const listed = Boolean(PAGE_META[(pathname || '/').replace(/\/+$/, '') || '/']);
  const url = listed ? `${SITE_ORIGIN}${pathname === '/' ? '/' : pathname.replace(/\/+$/, '')}` : SITE_ORIGIN;

  document.title = meta.title;
  upsertMeta('name', 'description', meta.description);
  upsertMeta('property', 'og:title', meta.title);
  upsertMeta('property', 'og:description', meta.description);
  upsertMeta('property', 'og:url', url);
  upsertMeta('name', 'twitter:title', meta.title);
  upsertMeta('name', 'twitter:description', meta.description);
  upsert(
    'link[rel="canonical"]',
    () => {
      const el = document.createElement('link');
      el.setAttribute('rel', 'canonical');
      return el;
    },
    'href',
    url
  );
}
