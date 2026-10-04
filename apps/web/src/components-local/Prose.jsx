import React from 'react';
import { Link } from 'react-router-dom';
import { Button, Icon } from '../components/index.js';
import { Nav, Footer } from '../routes/Marketing.jsx';

/**
 * The page kit for the site's long-form pages: the trust pages, the blog, the
 * comparisons and the agent pages (4 Oct 2026).
 *
 * The prose pieces are the docs' own vocabulary — the same `doc__*` classes
 * Docs.jsx renders — so a paragraph on /security and a paragraph in the docs
 * are one style, not two that drift. What is new is the frame: one article
 * column with an optional "on this page" rail, instead of the docs' three
 * columns, and the blocks every SEO page repeats (an FAQ that also writes its
 * FAQPage JSON-LD, a call-to-action band, a grid of link cards).
 *
 * Nothing here reads `window` while rendering: every page that uses it is
 * prerendered under Node (scripts/prerender.mjs).
 */

export const slug = text =>
  String(text).toLowerCase().replace(/^\d+\.\s*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function H2({ id, children }) {
  return <h2 id={id} className="doc__h2">{children}</h2>;
}

export function H3({ id, children }) {
  return <h3 id={id} className="doc__h3">{children}</h3>;
}

export function P({ children }) {
  return <p className="doc__p">{children}</p>;
}

export function List({ items, ordered = false }) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className="doc__list">
      {items.map((it, i) => <li key={i}>{it}</li>)}
    </Tag>
  );
}

export function Table({ caption, head, rows }) {
  return (
    <div className="doc__tablewrap">
      <table className="doc__table">
        {caption ? <caption className="doc__tablecap">{caption}</caption> : null}
        <thead>
          <tr>{head.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Code({ caption, children }) {
  return (
    <div className="doc__code">
      <div className="doc__codebar">
        <span className="doc__codecap">{caption}</span>
      </div>
      <pre className="doc__codebody">{children}</pre>
    </div>
  );
}

/* `label` names the note in a word, so colour never carries the meaning alone. */
export function Note({ tone, label, children }) {
  return (
    <div className={tone === 'warn' ? 'doc__note doc__note--warn' : 'doc__note'} role="note">
      {label ? (
        <span className="doc__notelabel">
          <Icon name="info" size={14} aria-hidden="true" />
          {label}
        </span>
      ) : null}
      <span>{children}</span>
    </div>
  );
}

/**
 * Structured data as a JSON-LD block. Rendered into the body, so the
 * prerendered HTML carries it for a crawler that runs no script. It is a
 * data block, never executed, so the CSP's script-src does not apply. `<`
 * is escaped so no string in it can close the element.
 */
export function JsonLd({ data }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}

/** The FAQPage object for a list of `{ q, a }`, where `a` is plain text. */
export function faqJsonLd(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a }
    }))
  };
}

/**
 * Five questions, visible on the page and repeated as FAQPage JSON-LD. The
 * answers are plain strings on purpose: the structured data must say exactly
 * what the page says, and a string is the one form both can share.
 */
export function Faq({ items, id = 'faq', title = 'Frequently asked questions' }) {
  return (
    <section className="doc__section" aria-labelledby={id}>
      <H2 id={id}>{title}</H2>
      {items.map(({ q, a }) => (
        <div key={q} className="pg__faqitem">
          <H3 id={slug(q)}>{q}</H3>
          {String(a).split('\n\n').map((para, i) => <P key={i}>{para}</P>)}
        </div>
      ))}
      <JsonLd data={faqJsonLd(items)} />
    </section>
  );
}

/** The closing call to action, in the landing page's band. */
export function CtaBand({ title, sub, to = '/signup', label = 'Try AgentDisk free', secondary }) {
  return (
    <section className="pg__cta">
      <div className="mk__band">
        <div className="mk__bandtext">
          <h2 className="mk__h2 pg__ctatitle">{title}</h2>
          {sub ? <p className="mk__bandsub">{sub}</p> : null}
        </div>
        <div className="pg__ctabtns">
          <Button size="lg" as={Link} to={to}>{label}</Button>
          {secondary ? (
            <Button size="lg" variant="secondary" as={Link} to={secondary.to}>{secondary.label}</Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** A grid of linked cards: the trust hub, the comparison index, the blog list. */
export function LinkCards({ items, label }) {
  return (
    <ul className="pg__cards" aria-label={label}>
      {items.map(it => (
        <li key={it.to}>
          <Link to={it.to} className="pg__card">
            {it.kicker ? <span className="mk__kicker">{it.kicker}</span> : null}
            <span className="pg__cardtitle">{it.title}</span>
            {it.body ? <span className="pg__cardbody">{it.body}</span> : null}
            {it.meta ? <span className="pg__cardmeta">{it.meta}</span> : null}
            {it.tags?.length ? (
              <span className="pg__tags">
                {it.tags.map(t => <span key={t} className="pg__tag">{t}</span>)}
              </span>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** "Yes" / "No" / "Partial" in a comparison cell: a word first, the tint second. */
export function Mark({ v, children }) {
  const tone = v === 'yes' ? 'pg__yes' : v === 'no' ? 'pg__no' : 'pg__part';
  const word = v === 'yes' ? 'Yes' : v === 'no' ? 'No' : 'Partial';
  return (
    <span className={tone}>
      <strong>{word}</strong>{children ? <> · {children}</> : null}
    </span>
  );
}

/**
 * The frame: nav, an article column with its heading block, an optional
 * "on this page" rail, the footer.
 *
 *   crumbs   [{ to, label }] ending at the current page (no `to`)
 *   toc      [{ id, label }] for the rail; omit for a single column
 *   meta     a line under the title, e.g. "Last reviewed: October 2026"
 */
export function SitePage({ kicker, title, lead, meta, crumbs, toc, children }) {
  return (
    <div className="mk">
      <Nav />
      <div className="mk__wrap">
        <div className={toc?.length ? 'pg' : 'pg pg--single'}>
          <article className="pg__body">
            {crumbs?.length ? (
              <nav className="doc__crumb" aria-label="Breadcrumb">
                {crumbs.map((c, i) => (
                  <React.Fragment key={c.label}>
                    {i > 0 ? <span aria-hidden="true">/</span> : null}
                    {c.to
                      ? <Link to={c.to}>{c.label}</Link>
                      : <span className="doc__crumbnow" aria-current="page">{c.label}</span>}
                  </React.Fragment>
                ))}
              </nav>
            ) : null}
            {kicker ? <div className="mk__kicker pg__kicker">{kicker}</div> : null}
            <h1 className="doc__h1">{title}</h1>
            {meta ? <p className="doc__meta">{meta}</p> : null}
            {lead ? <p className="doc__lead">{lead}</p> : null}
            {children}
          </article>
          {toc?.length ? (
            <aside className="pg__rail" aria-label="On this page">
              <div className="doc__raillabel">ON THIS PAGE</div>
              <div className="doc__raillist">
                {toc.map(t => (
                  <a key={t.id} href={`#${t.id}`} className="doc__railitem">{t.label}</a>
                ))}
              </div>
            </aside>
          ) : null}
        </div>
      </div>
      <Footer />
    </div>
  );
}
