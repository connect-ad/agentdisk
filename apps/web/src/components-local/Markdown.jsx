import React from 'react';
import { Link } from 'react-router-dom';
import { parseInline, headingId } from '../lib/markdown.js';
import { H2, H3, P, List, Table, Code } from './Prose.jsx';
import PostDiagram, { hasDiagram } from './PostDiagram.jsx';

/**
 * Parsed blog blocks (lib/markdown.js) as the same prose components the
 * trust and docs pages use. A link that starts with `/` is a router link; any
 * other opens where it points, with no referrer and no opener.
 *
 * A fence tagged `diagram` is the one block that is not prose: its body is
 * the name of a diagram in PostDiagram.jsx, because the parser has no HTML or
 * image block to carry one. A name nothing answers to renders as the ordinary
 * code block, so a typo is visible rather than a gap in the page.
 */

function Inline({ tokens }) {
  return tokens.map((tok, i) => {
    switch (tok.t) {
      case 'code': return <code key={i}>{tok.v}</code>;
      case 'strong': return <strong key={i}><Inline tokens={tok.c} /></strong>;
      case 'em': return <em key={i}><Inline tokens={tok.c} /></em>;
      case 'link':
        return tok.href.startsWith('/')
          ? <Link key={i} to={tok.href}><Inline tokens={tok.c} /></Link>
          : <a key={i} href={tok.href} target="_blank" rel="noopener noreferrer"><Inline tokens={tok.c} /></a>;
      default: return <React.Fragment key={i}>{tok.v}</React.Fragment>;
    }
  });
}

const inline = text => <Inline tokens={parseInline(text)} />;

export function MarkdownBlocks({ blocks }) {
  return blocks.map((b, i) => {
    switch (b.type) {
      case 'h2': return <H2 key={i} id={headingId(b.text)}>{inline(b.text)}</H2>;
      case 'h3': return <H3 key={i} id={headingId(b.text)}>{inline(b.text)}</H3>;
      case 'ul': return <List key={i} items={b.items.map(inline)} />;
      case 'ol': return <List key={i} ordered items={b.items.map(inline)} />;
      case 'code':
        return b.lang === 'diagram' && hasDiagram(b.text)
          ? <PostDiagram key={i} name={b.text} />
          : <Code key={i} caption={b.lang.toUpperCase()}>{b.text}</Code>;
      case 'table': return <Table key={i} head={b.head.map(inline)} rows={b.rows.map(r => r.map(inline))} />;
      case 'quote': return <blockquote key={i}>{inline(b.text)}</blockquote>;
      default: return <P key={i}>{inline(b.text)}</P>;
    }
  });
}

/** One string of inline markdown — links, `code`, **bold** — for the data-driven pages. */
export function Md({ children }) {
  return <Inline tokens={parseInline(String(children))} />;
}
