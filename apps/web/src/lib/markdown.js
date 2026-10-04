/**
 * The blog's markdown, parsed without a dependency (4 Oct 2026).
 *
 * The posts are ours and written to a small, fixed subset, so a parser for
 * exactly that subset is shorter than configuring a general one, adds nothing
 * to the bundle's dependency tree, and renders to React elements rather than
 * to an HTML string — no dangerouslySetInnerHTML for content, and internal
 * links become router links. The subset, for whoever writes the next post:
 *
 *   frontmatter   `key: value` lines between `---` fences; `[a, b]` arrays;
 *                 values optionally double-quoted
 *   blocks        `## ` and `### ` headings, paragraphs, single-level `- ` and
 *                 `1. ` lists, fenced code with a language, pipe tables, `> `
 *                 quotes
 *   inline        `code`, **bold**, *italic*, [text](href)
 *
 * Anything else is a paragraph of literal text, which is the failure a reader
 * would notice and a writer would fix. Plain JavaScript with no imports, so a
 * Node test can exercise it directly.
 */

/** `{ data, body }` from a file with a frontmatter block. */
export function parseFrontmatter(source) {
  const text = source.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  const data = {};
  for (const line of match[1].split('\n')) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const raw = m[2].trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      data[m[1]] = raw.slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else {
      data[m[1]] = unquote(raw);
    }
  }
  return { data, body: text.slice(match[0].length) };
}

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

const isTableRow = line => /^\s*\|.*\|\s*$/.test(line);
const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

/** The body as a list of blocks: `{ type, ... }`. */
export function parseBlocks(body) {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }

    const fence = /^```\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i += 1; }
      i += 1;
      blocks.push({ type: 'code', lang: fence[1] || 'text', text: code.join('\n') });
      continue;
    }

    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: heading[1].length === 2 ? 'h2' : 'h3', text: heading[2].trim() });
      i += 1;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) { rows.push(cells(lines[i])); i += 1; }
      blocks.push({ type: 'table', head, rows });
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, '').trim());
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '').trim());
        i += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i += 1; }
      blocks.push({ type: 'quote', text: quote.join(' ').trim() });
      continue;
    }

    const para = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^```/.test(lines[i]) && !/^#{2,3}\s/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) && !isTableRow(lines[i])
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: 'p', text: para.join(' ') });
  }
  return blocks;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*?\*)/g;

/**
 * Inline text as tokens: `{ t: 'text' | 'code' | 'strong' | 'em' | 'link', ... }`.
 * Strong, emphasis and link text are tokenised again, so `**[a](/b)**` works.
 */
export function parseInline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    const s = m[0];
    if (m[1]) out.push({ t: 'code', v: s.slice(1, -1) });
    else if (m[2]) out.push({ t: 'strong', c: parseInline(s.slice(2, -2)) });
    else if (m[3]) {
      const split = s.lastIndexOf('](');
      out.push({ t: 'link', href: s.slice(split + 2, -1), c: parseInline(s.slice(1, split)) });
    } else out.push({ t: 'em', c: parseInline(s.slice(1, -1)) });
    last = m.index + s.length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

/** The text a reader sees, with the markup removed: for JSON-LD and word counts. */
export function plainText(text) {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+?)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\*([^*\s][^*]*?)\*/g, '$1');
}

/**
 * Split off the closing FAQ: everything from the `## Frequently asked
 * questions` heading on becomes `[{ q, a }]`, with plain-text answers, so the
 * page and its FAQPage JSON-LD say the same words.
 */
export function splitFaq(blocks) {
  const at = blocks.findIndex(b => b.type === 'h2' && /^frequently asked questions$/i.test(b.text));
  if (at < 0) return { body: blocks, faq: [] };
  const faq = [];
  for (const b of blocks.slice(at + 1)) {
    if (b.type === 'h2') break;
    if (b.type === 'h3') faq.push({ q: plainText(b.text), a: '' });
    else if (faq.length && b.type === 'p') {
      const prev = faq[faq.length - 1];
      prev.a = prev.a ? `${prev.a}\n\n${plainText(b.text)}` : plainText(b.text);
    }
  }
  return { body: blocks.slice(0, at), faq };
}

/** Words in the post, code included, at the usual 230 a minute, never under one. */
export function readingMinutes(body) {
  const words = body.replace(/[#*`>|[\]()-]/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 230));
}

/** The same slug the docs use for heading ids. */
export function headingId(text) {
  return plainText(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
