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
 * is over there" if a crawler ever gets past the noindex. It is the brand
 * domain, not the app host: since 30 Sept 2026 the marketing pages live on
 * agentdisk.io and the app on app.agentdisk.io (see lib/hosts.js), and the
 * app host serves these same pages with a noindex, so the canonical is what
 * tells a crawler which copy is the real one.
 */

export const SITE_ORIGIN = 'https://agentdisk.io';
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
      'How to give an AI agent a disk: connect Claude, Cursor or any MCP client, use the REST API, and see exactly how your data is kept and deleted.'
  },
  // The trust pages, out of the docs since 4 Oct 2026 (routes/Trust.jsx).
  '/security': {
    title: 'Security — AgentDisk',
    description:
      "How AgentDisk protects your AI agents' data: encryption, tenant isolation, scoped credentials, Cloudflare edge security, and more than 1,000 automated tests."
  },
  '/privacy': {
    title: 'Privacy Policy — AgentDisk',
    description:
      'What AgentDisk collects, how we handle your data, retention, cookies, the processors we use, and your rights.'
  },
  '/terms': {
    title: 'Terms of Service — AgentDisk',
    description:
      'Terms of Service for AgentDisk — acceptable use, content policies, billing, agent API use, and limitation of liability.'
  },
  '/trust': {
    title: 'Trust Center — AgentDisk',
    description:
      'AgentDisk Trust Center: security architecture, privacy policy, terms of service and sub-processor transparency.'
  },
  '/sub-processors': {
    title: 'Sub-processors — AgentDisk',
    description:
      'Third-party sub-processors used by AgentDisk: Cloudflare, Firebase, Stripe and Google Analytics, and what each one processes.'
  },
  '/dpa': {
    title: 'Data Processing Agreement — AgentDisk',
    description:
      'The AgentDisk Data Processing Agreement: our GDPR Article 28 commitments as your processor, with the EU Standard Contractual Clauses for international transfers.'
  },
  // Index pages. The posts, comparisons and agent pages carry their own
  // metadata beside their content; lib/pages.js gathers it.
  '/blog': {
    title: 'Blog — AgentDisk',
    description:
      'Tutorials, architecture and security writing from the team behind AgentDisk, file storage built for AI agents.'
  },
  '/compare': {
    title: 'Compare AgentDisk — AgentDisk',
    description:
      'AgentDisk compared with Fast.io, Amazon S3, Diskd.ai, Cloudflare R2 and Composio for AI agent file storage, including where each one wins.'
  },
  '/alternatives': {
    title: 'Alternatives — AgentDisk',
    description:
      'AgentDisk as an alternative to Fast.io and S3 for AI agents, and as file storage beside Composio: why teams switch and how to move.'
  }
};

/**
 * The routes that get a static file at build, and therefore their own title
 * and canonical URL. The prerender renders exactly these, and the sitemap
 * lists exactly these: a route whose canonical points at `/` does not belong
 * in a sitemap, so the two lists must be one list.
 *
 * These are the hand-written pages. The blog posts, comparisons,
 * alternatives and agent pages are added by lib/pages.js from their content,
 * and the prerender and the sitemap read the combined list from there.
 */
export const PRERENDERED_ROUTES = Object.keys(PAGE_META);

/**
 * The `sitemap.xml` body, written to `dist/` at build. Production URLs in
 * every environment, for the same reason as `SITE_ORIGIN`. No `lastmod`: the
 * build does not know when a page's content last changed, and a date that is
 * really the deploy time is a date a crawler learns to ignore.
 */
export function renderSitemapFile(routes = PRERENDERED_ROUTES) {
  const urls = routes.map(route => `  <url><loc>${SITE_ORIGIN}${route}</loc></url>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    ''
  ].join('\n');
}

/**
 * The table entry for a pathname, or the default for anything not listed.
 * `extra` is the metadata that lives beside content (lib/pages.js): the blog
 * posts, the comparisons and the agent pages. It is a parameter rather than
 * an import so this file stays importable by Node with no bundler.
 */
export function metaFor(pathname, extra = {}) {
  const path = (pathname || '/').replace(/\/+$/, '') || '/';
  return extra[path] ?? PAGE_META[path] ?? DEFAULT_META;
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
export function headTags(route, extra = {}) {
  const meta = metaFor(route, extra);
  const url = `${SITE_ORIGIN}${route === '/' ? '/' : route}`;
  const tags = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="${meta.type === 'article' ? 'article' : 'website'}" />`,
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
  if (meta.published) {
    tags.push(`<meta property="article:published_time" content="${escapeHtml(meta.published)}" />`);
  }
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
export function applyPageMeta(pathname, extra = {}) {
  if (typeof document === 'undefined') return;
  const meta = metaFor(pathname, extra);
  const key = (pathname || '/').replace(/\/+$/, '') || '/';
  const listed = Boolean(extra[key] ?? PAGE_META[key]);
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
