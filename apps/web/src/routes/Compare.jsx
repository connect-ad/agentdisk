import React from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  SitePage, H2, P, List, Table, Note, Faq, CtaBand, LinkCards, Mark, Code, slug
} from '../components-local/Prose.jsx';
import { Md } from '../components-local/Markdown.jsx';
import { COMPARISONS, ALTERNATIVES, comparisonBySlug, alternativeBySlug } from '../content/compare.js';
import { AGENT_PAGES } from '../content/agents.js';
import { postBySlug } from '../lib/blog.js';
import { NotFound } from './ErrorPages.jsx';

/**
 * /compare, /compare/:slug, /alternatives, /alternatives/:slug and the four
 * /storage-for-<agent> pages (4 Oct 2026). Content is in src/content; this
 * file only lays it out, so every page of a kind has the same sections in
 * the same order.
 */

const CTA = (
  <CtaBand
    title="Try AgentDisk free"
    sub="1 GB and one agent identity with no card, or a sandbox with no account at all."
    secondary={{ to: '/pricing', label: 'See pricing' }}
  />
);

function Cell({ cell }) {
  const [mark, note] = cell;
  return mark ? <Mark v={mark}><Md>{note}</Md></Mark> : <Md>{note}</Md>;
}

function FeatureTable({ rows, name }) {
  return (
    <Table
      head={['', 'AgentDisk', name]}
      rows={rows.map(([label, ours, theirs]) => [
        <strong key="l">{label}</strong>, <Cell key="a" cell={ours} />, <Cell key="b" cell={theirs} />,
      ])}
    />
  );
}

/** Related reading: the posts named in the content, then the product and trust pages. */
function Related({ posts }) {
  const items = posts.map(postBySlug).filter(Boolean).map(p => ({
    to: `/blog/${p.slug}`, kicker: 'BLOG', title: p.title, body: p.description,
  }));
  items.push(
    { to: '/docs/quickstart', kicker: 'DOCS', title: 'Quick start', body: 'Connect your MCP client or the REST API in a few minutes.' },
    { to: '/security', kicker: 'TRUST', title: 'Security', body: 'Encryption, tenant isolation, credentials and the providers\' certifications.' },
  );
  return (
    <section className="doc__section" aria-labelledby="related">
      <H2 id="related">Related reading</H2>
      <LinkCards label="Related reading" items={items} />
    </section>
  );
}

/* ═════════════════════════════ /compare ═════════════════════════════ */

export function CompareIndex() {
  return (
    <SitePage
      kicker="COMPARE"
      title="Compare AgentDisk"
      lead="How AgentDisk compares with other ways to give an AI agent file storage, including where the other option is the better choice."
    >
      <LinkCards
        label="Comparisons"
        items={COMPARISONS.map(c => ({ to: `/compare/${c.slug}`, kicker: `VS ${c.name.toUpperCase()}`, title: `AgentDisk vs ${c.name}`, body: c.description }))}
      />
      <H2 id="alternatives">Alternatives</H2>
      <LinkCards
        label="Alternatives"
        items={ALTERNATIVES.map(a => ({ to: `/alternatives/${a.slug}`, kicker: 'ALTERNATIVE', title: `Looking for a ${a.name} alternative?`, body: a.description }))}
      />
      <H2 id="use-with">Use AgentDisk with</H2>
      <LinkCards
        label="Agents"
        items={AGENT_PAGES.map(p => ({ to: p.path, kicker: 'AGENT', title: `File storage for ${p.name}`, body: p.description }))}
      />
      {CTA}
    </SitePage>
  );
}

/* ═════════════════════════════ /compare/:slug ═════════════════════════════ */

const SECTION_ORDER = ['Pricing', 'Security', 'Setup', 'API design', 'Best for'];

export function ComparePage() {
  const { slug: key } = useParams();
  const c = comparisonBySlug(key);
  if (!c) return <NotFound />;
  const toc = [
    { id: 'verdict', label: 'Quick verdict' },
    { id: 'features', label: 'Feature comparison' },
    ...SECTION_ORDER.map(s => ({ id: slug(s), label: s })),
    { id: 'faq', label: 'FAQ' },
  ];
  return (
    <SitePage
      crumbs={[{ to: '/compare', label: 'Compare' }, { label: `AgentDisk vs ${c.name}` }]}
      kicker="COMPARE"
      title={c.h1}
      meta="Last reviewed: October 2026"
      toc={toc}
    >
      <section className="doc__section" aria-labelledby="verdict">
        <H2 id="verdict">Quick verdict</H2>
        <P><Md>{c.verdict}</Md></P>
      </section>
      <section className="doc__section" aria-labelledby="features">
        <H2 id="features">Feature comparison</H2>
        <FeatureTable rows={c.rows} name={c.name} />
        <Note label="Sources">
          AgentDisk entries describe the running product, see the <Link to="/docs">docs</Link>.{' '}
          {c.name} entries are from public information as of October 2026 and may have changed;
          check {c.name}'s own site before deciding.
        </Note>
      </section>
      {SECTION_ORDER.map(name => (
        <section key={name} className="doc__section" aria-labelledby={slug(name)}>
          <H2 id={slug(name)}>{name}</H2>
          {c.sections[name].map((para, i) => <P key={i}><Md>{para}</Md></P>)}
        </section>
      ))}
      <Faq items={c.faq} />
      {CTA}
      <Related posts={c.posts} />
    </SitePage>
  );
}

/* ═════════════════════════════ /alternatives ═════════════════════════════ */

export function AlternativesIndex() {
  return (
    <SitePage
      kicker="ALTERNATIVES"
      title="AgentDisk as an alternative"
      lead="Why teams look at AgentDisk instead of, or beside, the storage they use today, and what moving takes."
    >
      <LinkCards
        label="Alternatives"
        items={ALTERNATIVES.map(a => ({ to: `/alternatives/${a.slug}`, kicker: 'ALTERNATIVE', title: `Looking for a ${a.name} alternative?`, body: a.description }))}
      />
      <P>Side-by-side tables are on <Link to="/compare">Compare</Link>.</P>
      {CTA}
    </SitePage>
  );
}

/* ═════════════════════════════ /alternatives/:slug ═════════════════════════════ */

export function AlternativePage() {
  const { slug: key } = useParams();
  const a = alternativeBySlug(key);
  const c = a ? comparisonBySlug(a.compare) : null;
  if (!a || !c) return <NotFound />;
  return (
    <SitePage
      crumbs={[{ to: '/alternatives', label: 'Alternatives' }, { label: a.name }]}
      kicker="ALTERNATIVE"
      title={`Looking for a ${a.name} alternative?`}
      meta="Last reviewed: October 2026"
      lead={c.verdict}
      toc={[
        { id: 'why-switch', label: 'Why people switch' },
        { id: 'features', label: 'Feature comparison' },
        { id: 'migration', label: 'Migration guide' },
        { id: 'faq', label: 'FAQ' },
      ]}
    >
      <section className="doc__section" aria-labelledby="why-switch">
        <H2 id="why-switch">Why people switch</H2>
        <List items={a.reasons.map((r, i) => <Md key={i}>{r}</Md>)} />
        <Note label="When to stay"><Md>{a.stay}</Md></Note>
      </section>
      <section className="doc__section" aria-labelledby="features">
        <H2 id="features">Feature comparison</H2>
        <FeatureTable rows={c.rows} name={c.name} />
        <P>The full comparison is in <Link to={`/compare/${c.slug}`}>AgentDisk vs {c.name}</Link>.</P>
      </section>
      <section className="doc__section" aria-labelledby="migration">
        <H2 id="migration">Migration guide</H2>
        <List ordered items={a.migration.map((m, i) => <Md key={i}>{m}</Md>)} />
      </section>
      <Faq items={a.faq} />
      {CTA}
      <Related posts={c.posts} />
    </SitePage>
  );
}

/* ═════════════════════════════ /storage-for-<agent> ═════════════════════════════ */

export function AgentLanding({ page }) {
  return (
    <SitePage
      crumbs={[{ to: '/compare', label: 'Use with' }, { label: page.name }]}
      kicker={`FOR ${page.name.toUpperCase()}`}
      title={`File Storage for ${page.name}`}
      lead={page.lead}
      toc={[
        { id: 'connect', label: 'Connect' },
        { id: 'use-cases', label: 'Use cases' },
        { id: 'features', label: 'What you get' },
        { id: 'pricing', label: 'Pricing' },
        { id: 'faq', label: 'FAQ' },
      ]}
    >
      <section className="doc__section" aria-labelledby="connect">
        <H2 id="connect">Connect {page.name} to AgentDisk</H2>
        <P>
          Create a key in the dashboard (or a <Link to="/sandbox">sandbox</Link> with no account),
          then add one block. Replace the placeholder with your key; the full walkthrough is
          the <Link to="/docs/quickstart">quick start</Link>.
        </P>
        {page.configs.map(cfg => (
          <React.Fragment key={cfg.caption}>
            <P><Md>{cfg.intro}</Md></P>
            <Code caption={cfg.caption}>{cfg.code}</Code>
          </React.Fragment>
        ))}
      </section>
      <section className="doc__section" aria-labelledby="use-cases">
        <H2 id="use-cases">Use cases</H2>
        <List items={page.uses.map(([title, body]) => <><strong>{title}.</strong> <Md>{body}</Md></>)} />
      </section>
      <section className="doc__section" aria-labelledby="features">
        <H2 id="features">What you get</H2>
        <List items={[
          <><strong>Scoped credentials.</strong> Each key carries operations and a path prefix, so {page.name} gets exactly the access you choose and nothing beside it.</>,
          <><strong>Persistent storage.</strong> Files, folders, captions, tags and metadata that outlive the session, readable inline up to 1 MB.</>,
          <><strong>Hard-capped pricing.</strong> Unlimited requests, egress included, and a refusal rather than an overage charge at the limit.</>,
          <><strong>An audit log.</strong> Every MCP call with its path and outcome, refusals included. See <Link to="/security">Security</Link>.</>,
        ]} />
      </section>
      <section className="doc__section" aria-labelledby="pricing">
        <H2 id="pricing">Pricing</H2>
        <P>
          <strong>Free:</strong> 1 GB of storage, 10 GB of egress a month and one agent
          identity, no card. Paid plans are $9, $20 and $80 a month; every plan is hard-capped.
          See <Link to="/pricing">Pricing</Link>.
        </P>
      </section>
      <Faq items={page.faq} />
      <CtaBand
        title={`Connect ${page.name} to AgentDisk in 2 minutes`}
        sub="Start free with no card, or give it a sandbox with no account."
        secondary={{ to: '/sandbox', label: 'Open a sandbox' }}
      />
      <Related posts={page.posts} />
    </SitePage>
  );
}

/** One component per route, so the route table stays a list of elements. */
export const StorageForClaude = () => <AgentLanding page={AGENT_PAGES[0]} />;
export const StorageForOpenAI = () => <AgentLanding page={AGENT_PAGES[1]} />;
export const StorageForCursor = () => <AgentLanding page={AGENT_PAGES[2]} />;
export const StorageForCline = () => <AgentLanding page={AGENT_PAGES[3]} />;
