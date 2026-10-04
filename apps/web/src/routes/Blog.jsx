import React from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { SitePage, Faq, CtaBand, LinkCards, JsonLd } from '../components-local/Prose.jsx';
import { MarkdownBlocks } from '../components-local/Markdown.jsx';
import { headingId } from '../lib/markdown.js';
import { POSTS, POSTS_PER_PAGE, postBySlug, relatedPosts, formatDate } from '../lib/blog.js';
import { SITE_ORIGIN, SOCIAL_IMAGE } from '../lib/seo.js';
import { NotFound } from './ErrorPages.jsx';

/**
 * /blog and /blog/:slug (4 Oct 2026). The posts are markdown files in
 * src/content/blog, loaded by lib/blog.js; this file only lays them out.
 *
 * The index takes `?tag=` (the footer's Tutorials and Security guides) and
 * `?page=`, ten to a page. Only the unfiltered first page is prerendered and
 * in the sitemap; the filtered views carry the same canonical, /blog.
 */

const postCard = p => ({
  to: `/blog/${p.slug}`,
  title: p.title,
  body: p.description,
  meta: `${formatDate(p.date)} · ${p.minutes} min read`,
  tags: p.tags,
});

export function BlogIndex() {
  const [params] = useSearchParams();
  const tag = params.get('tag') || '';
  const listed = tag ? POSTS.filter(p => p.tags.includes(tag)) : POSTS;
  const pages = Math.max(1, Math.ceil(listed.length / POSTS_PER_PAGE));
  const page = Math.min(pages, Math.max(1, Number(params.get('page')) || 1));
  const shown = listed.slice((page - 1) * POSTS_PER_PAGE, page * POSTS_PER_PAGE);
  const href = n => {
    const q = new URLSearchParams();
    if (tag) q.set('tag', tag);
    if (n > 1) q.set('page', String(n));
    const s = q.toString();
    return s ? `/blog?${s}` : '/blog';
  };

  return (
    <SitePage
      kicker="BLOG"
      title={tag ? `Posts tagged ${tag}` : 'Blog'}
      lead="How AgentDisk is built and how to use it: tutorials, architecture, security and the decisions behind them, written by the people who made it."
    >
      {tag ? (
        <p className="pg__pager"><Link to="/blog">All posts</Link></p>
      ) : null}
      {shown.length
        ? <LinkCards label="Posts" items={shown.map(postCard)} />
        : <p className="doc__p">No posts with that tag yet. <Link to="/blog">See every post</Link>.</p>}
      {pages > 1 ? (
        <nav className="pg__pager" aria-label="Pages">
          {page > 1 ? <Link to={href(page - 1)}>← Newer posts</Link> : <span />}
          <span>Page {page} of {pages}</span>
          {page < pages ? <Link to={href(page + 1)}>Older posts →</Link> : <span />}
        </nav>
      ) : null}
      <CtaBand
        title="Start storing files for your AI agents"
        sub="Free for 1 GB and one agent identity. No card, and a sandbox needs no account at all."
        secondary={{ to: '/docs/quickstart', label: 'Quick start' }}
      />
    </SitePage>
  );
}

function articleJsonLd(post) {
  const url = `${SITE_ORIGIN}/blog/${post.slug}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    dateModified: post.date,
    author: { '@type': 'Organization', name: post.author },
    publisher: {
      '@type': 'Organization',
      name: 'AgentDisk',
      logo: { '@type': 'ImageObject', url: SOCIAL_IMAGE },
    },
    image: SOCIAL_IMAGE,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    url,
    keywords: post.keywords.join(', '),
  };
}

export function BlogPost() {
  const { slug } = useParams();
  const post = postBySlug(slug);
  if (!post) return <NotFound />;

  const toc = post.blocks
    .filter(b => b.type === 'h2')
    .map(b => ({ id: headingId(b.text), label: b.text.replace(/[`*]/g, '') }));
  if (post.faq.length) toc.push({ id: 'faq', label: 'FAQ' });
  const related = relatedPosts(post);

  return (
    <SitePage
      crumbs={[{ to: '/blog', label: 'Blog' }, { label: post.title }]}
      title={post.title}
      toc={toc}
    >
      <p className="pg__byline">
        <span>{post.author}</span>
        <time dateTime={post.date}>{formatDate(post.date)}</time>
        <span>{post.minutes} min read</span>
        <span className="pg__tags">
          {post.tags.map(t => (
            <Link key={t} to={`/blog?tag=${encodeURIComponent(t)}`} className="pg__tag">{t}</Link>
          ))}
        </span>
      </p>
      <JsonLd data={articleJsonLd(post)} />
      <MarkdownBlocks blocks={post.blocks} />
      {post.faq.length ? <Faq items={post.faq} /> : null}
      <CtaBand
        title="Start storing files for your AI agents"
        sub="Try AgentDisk free: 1 GB and one agent identity, no card. Or open a sandbox with no account at all."
        secondary={{ to: '/sandbox', label: 'Open a sandbox' }}
      />
      {related.length ? (
        <section className="doc__section" aria-labelledby="related">
          <h2 id="related" className="doc__h2">Related posts</h2>
          <LinkCards label="Related posts" items={related.map(postCard)} />
        </section>
      ) : null}
    </SitePage>
  );
}
